import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../app.js';
import { AwsIdentityError, createAwsIdentityGuard, createAwsTranslator } from '../aws-identity.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

let translator;
try {
  const config = loadConfig(process.env);
  const verifyAwsIdentity = createAwsIdentityGuard(config);
  const identity = await verifyAwsIdentity();
  translator = createAwsTranslator(config, identity.credentials);
  const translatedText = await translator.translate({
    text: 'مرحبا من ديففست',
    sourceLanguage: 'ar',
    targetLanguage: 'en',
  });

  console.log('PASS: STS verified the configured DEVFEST account, then one real Amazon Translate request succeeded.');
  console.log(`Verified account: ${identity.account}`);
  console.log(`Credential source: ${identity.credentialSource}`);
  console.log(`Region: ${config.region}`);
  console.log(`Translated text: ${translatedText}`);
} catch (error) {
  if (error instanceof AwsIdentityError) {
    console.error(`BLOCKED: ${error.message} (${error.code})`);
    console.error('No Amazon Translate request was made.');
    process.exitCode = 2;
  } else {
    console.error(`FAIL: the verified DEVFEST identity could not complete the Translate request (${error?.name || 'UnknownError'}).`);
    process.exitCode = 1;
  }
} finally {
  translator?.destroy();
}
