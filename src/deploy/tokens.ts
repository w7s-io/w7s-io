const textEncoder = new TextEncoder();

const base64Url = (bytes: Uint8Array) => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const generateBindingToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
};

export const hashBindingToken = async (token: string) => {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return base64Url(new Uint8Array(digest));
};
