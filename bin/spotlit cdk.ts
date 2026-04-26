#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SpotlitCdkStack } from '../lib/stack';
import { CertStack } from '../lib/cert-stack';

const app = new cdk.App();

const certStack = new CertStack(app, 'CertStack', {
  crossRegionReferences: true,
});

new SpotlitCdkStack(app, 'SpotlitCdkStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  certificateArn: certStack.certificate.certificateArn,
  crossRegionReferences: true,
});
