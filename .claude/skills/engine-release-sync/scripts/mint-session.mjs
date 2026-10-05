// Mints an Auth.js session token the engine accepts as a browser session, the
// same way the web app encrypts its cookie. Only for an ephemeral instance whose
// AUTH_SECRET you generated: it is how a fresh engine gets its first management
// key without a browser.
// Usage: node mint-session.mjs <engine-node_modules> <AUTH_SECRET> <userId> <email> <orgId>
const [nm, secret, sub, email, orgId] = process.argv.slice(2);
const { hkdf } = await import(`${nm}/@panva/hkdf/dist/node/esm/index.js`);
const { EncryptJWT } = await import(`${nm}/jose/dist/webapi/index.js`);
const salt = "authjs.session-token";
const key = new Uint8Array(await hkdf("sha256", secret, salt, `Auth.js Generated Encryption Key (${salt})`, 64));
const jwt = await new EncryptJWT({ sub, email, name: "CLI sync admin", orgId })
  .setProtectedHeader({ alg: "dir", enc: "A256CBC-HS512" })
  .setIssuedAt()
  .setExpirationTime("8h")
  .encrypt(key);
console.log(jwt);
