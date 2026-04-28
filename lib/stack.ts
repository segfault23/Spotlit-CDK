import { join } from 'path';
import { Construct } from 'constructs';
import { Code, Function, FunctionUrlAuthType, HttpMethod, Runtime } from 'aws-cdk-lib/aws-lambda';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  OAuthScope,
  ProviderAttribute,
  UserPool,
  UserPoolClientIdentityProvider,
  UserPoolIdentityProviderGoogle,
} from 'aws-cdk-lib/aws-cognito';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { CachePolicy, Distribution, OriginProtocolPolicy, OriginRequestPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';

export interface SpotlitCdkStackProps extends StackProps {
  certificateArn: string;
  webAclId?: string;
}

export class SpotlitCdkStack extends Stack {
  constructor(scope: Construct, id: string, props: SpotlitCdkStackProps) {
    super(scope, id, props);

    const svelteKitBuildPath = join(__dirname, '../../spotlit/build');

    // ── DynamoDB ──────────────────────────────────────────────────────────────
    const contentTable = new Table(this, 'SpotlitContent', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    contentTable.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── Cognito ───────────────────────────────────────────────────────────────
    // Prerequisites (must exist in SSM & Secrets Manager before deploying):
    //   /spotlit/google-client-id     → String      (from Google Cloud Console)
    //   /spotlit/google-client-secret → Secret manager (from Google Cloud Console)
    // See SETUP.md for the full two-step first-deploy process.

    const googleClientId = StringParameter.valueForStringParameter(
      this, '/spotlit/google-client-id',
    );

    const googleSecret = Secret.fromSecretCompleteArn(
      this,
      'GoogleClientSecret',
      'arn:aws:secretsmanager:eu-west-2:277707120040:secret:/spotlit/google-client-secret-mff2JG'
    );

    const userPool = new UserPool(this, 'SpotlitUserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const googleProvider = new UserPoolIdentityProviderGoogle(this, 'GoogleProvider', {
      userPool,
      clientId: googleClientId,
      // SecureString resolved by CloudFormation at deploy time — never in plaintext
      clientSecretValue: googleSecret.secretValue,
      scopes: ['email', 'profile', 'openid'],
      attributeMapping: {
        email: ProviderAttribute.GOOGLE_EMAIL,
        givenName: ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: ProviderAttribute.GOOGLE_FAMILY_NAME,
      },
    });

    // Cognito domain prefix must be globally unique — change if deploy fails
    const cognitoDomain = userPool.addDomain('SpotlitDomain', {
      cognitoDomain: { domainPrefix: 'spotlit-app' },
    });

    // appUrl context: set after first deploy so Cognito knows the real callback URL.
    // First deploy:  cdk deploy                          (uses localhost placeholder)
    // Second deploy: cdk deploy --context appUrl=<fn-url> (locks in real URL)
    const appUrl = this.node.tryGetContext('appUrl') as string | undefined;
    const callbackUrl = appUrl ? `${appUrl}/auth/callback` : 'https://localhost:5173/auth/callback';
    const logoutUrl   = appUrl ?? 'https://localhost:5173';

    const userPoolClient = userPool.addClient('SpotlitAppClient', {
      userPoolClientName: 'SpotlitAppClient',
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [callbackUrl],
        logoutUrls: [logoutUrl],
      },
      supportedIdentityProviders: [
        UserPoolClientIdentityProvider.COGNITO,
        UserPoolClientIdentityProvider.GOOGLE,
      ],
      authFlows: { userPassword: true, userSrp: true, adminUserPassword: true },
      preventUserExistenceErrors: true,
    });

    // Google IdP must exist before the client can reference it
    userPoolClient.node.addDependency(googleProvider);

    // ── Lambda ────────────────────────────────────────────────────────────────
    const fn = new Function(this, 'SpotlitApp', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'lambda.handler',
      code: Code.fromAsset(svelteKitBuildPath),
      timeout: Duration.seconds(30),
      memorySize: 256,
      description: 'Spotlit SvelteKit app',
      environment: {
        CONTENT_TABLE: contentTable.tableName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_DOMAIN: cognitoDomain.baseUrl(),
        ...(appUrl ? { PUBLIC_ORIGIN: appUrl } : {}),
      },
    });

    contentTable.grantReadWriteData(fn);

    // Lambda needs to fetch its own client secret at runtime via DescribeUserPoolClient
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['cognito-idp:DescribeUserPoolClient'],
      resources: [userPool.userPoolArn],
    }));

    const url = fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedMethods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.DELETE],
        allowedOrigins: ['*'],
      },
    });

    const cert = Certificate.fromCertificateArn(
      this,
      'ImportedCert',
      props.certificateArn
    );

    console.log(Fn.parseDomainName(url.url));
    
    const originDomain = Fn.parseDomainName(url.url);

    const distribution = new Distribution(this, 'SpotlitDistribution', {
      defaultBehavior: {
        origin: new HttpOrigin(originDomain, {
          protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
        }),
        cachePolicy: CachePolicy.CACHING_DISABLED,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Forward all query strings, headers, and cookies to Lambda
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
      },
      domainNames: ['spotlit.online'],
      certificate: cert,
      // Preserve any WAF Web ACL that was associated with this distribution.
      // Pass via: cdk deploy --context webAclId=arn:aws:wafv2:us-east-1:...
      ...(props.webAclId ? { webAclId: props.webAclId } : {}),
    });
    
    const zone = HostedZone.fromLookup(this, 'Zone', {
      domainName: 'spotlit.online',
    });

    new ARecord(this, 'AliasRecord', {
      zone,
      target: RecordTarget.fromAlias(
        new CloudFrontTarget(distribution)
      ),
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new CfnOutput(this, 'FunctionUrl', {
      value: url.url,
      description: 'Spotlit app URL — use this as appUrl context on second deploy',
    });
    new CfnOutput(this, 'ContentTableName', {
      value: contentTable.tableName,
      description: 'DynamoDB content table name',
    });
    new CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });
    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID',
    });
    new CfnOutput(this, 'CognitoDomain', {
      value: cognitoDomain.baseUrl(),
      description: 'Cognito Hosted UI base URL',
    });
  }
}
