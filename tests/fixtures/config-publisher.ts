import { createConfigIfAbsent, defaultConfig } from '../../src/config.js';

const [dir, value] = process.argv.slice(2);
const config = defaultConfig(dir);
config.integration.maxOutputChars = Number(value);
process.once('message', () => {
  try {
    const created = createConfigIfAbsent(config);
    process.send!({ created, value: Number(value) }, () => process.disconnect!());
  } catch (error) {
    process.stderr.write(String(error));
    process.exitCode = 1;
    process.disconnect!();
  }
});
process.send!({ ready: true });
