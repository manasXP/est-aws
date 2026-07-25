import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';

export const handler = createLambdaHandler(() => import('./str004-full-block-set.js'));
