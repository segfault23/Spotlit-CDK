import { join } from 'path';
import { Construct } from 'constructs';
import { Code, Function, FunctionUrlAuthType, HttpMethod, Runtime } from 'aws-cdk-lib/aws-lambda';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';

export class SpotlitCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const svelteKitBuildPath = join(__dirname, '../../spotlit/build');

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
      },
    });

    contentTable.grantReadWriteData(fn);

    const url = fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedMethods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT, HttpMethod.DELETE],
        allowedOrigins: ['*'],
      },
    });

    new CfnOutput(this, 'FunctionUrl', {
      value: url.url,
      description: 'Spotlit app URL',
    });

    new CfnOutput(this, 'ContentTableName', {
      value: contentTable.tableName,
      description: 'DynamoDB content table name',
    });
  }
}
