import { join } from 'path';
import { Construct } from 'constructs';
import { Code, Function, FunctionUrlAuthType, HttpMethod, Runtime } from 'aws-cdk-lib/aws-lambda';
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';

export class SpotlitCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const svelteKitBuildPath = join(__dirname, '../../spotlit/build');

    const fn = new Function(this, 'SpotlitApp', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromAsset(svelteKitBuildPath),
      timeout: Duration.seconds(30),
      memorySize: 256,
      description: 'Spotlit SvelteKit app',
    });

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
  }
}
