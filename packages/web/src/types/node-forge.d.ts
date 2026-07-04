declare module "node-forge" {
  namespace forge {
    namespace pki {
      function publicKeyFromPem(pem: string): PublicKey;
      interface PublicKey {
        encrypt(data: string | util.ByteBuffer, scheme: "RSA-OAEP", options?: {
          md?: md.MessageDigest;
          mgf1?: { md?: md.MessageDigest };
        }): string;
      }
    }
    namespace md {
      namespace sha256 {
        function create(): MessageDigest;
      }
      interface MessageDigest {}
    }
    namespace util {
      function encodeUtf8(str: string): ByteBuffer;
      function encode64(bytes: string): string;
      interface ByteBuffer {}
    }
  }
  export = forge;
}
