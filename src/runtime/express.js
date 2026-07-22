import miniExpress from './miniExpress.js';

let runtime = miniExpress;
try {
  const loaded = await import('express');
  runtime = loaded.default || loaded;
} catch (error) {
  if (process.env.BRIDGE_REQUIRE_EXTERNAL_RUNTIME === '1') throw error;
}

export default runtime;
