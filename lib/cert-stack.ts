import { env } from 'process';
import { Stack, StackProps, CfnOutput, Fn } from 'aws-cdk-lib';
import { ICertificate, Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class CertStack extends Stack {
  public readonly certificate: ICertificate;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      env: {
        account: env.CDK_DEFAULT_ACCOUNT,
        region: 'us-east-1', // us-east-1 is required for certificates
      },
    });


    const zone = new HostedZone(this, 'SpotlitZone', {
      zoneName: 'spotlit.online',
    });

    const cert = new Certificate(this, 'SpotlitCert', {
      domainName: 'spotlit.online',
      subjectAlternativeNames: ['www.spotlit.online'],
      validation: CertificateValidation.fromDns(zone),
    });

    this.certificate = cert;

    new CfnOutput(this, 'CertificateArn', {
      value: cert.certificateArn,
    });

    new CfnOutput(this, 'NameServers', {
      value: Fn.join(', ', zone.hostedZoneNameServers!),
    });
  }
}