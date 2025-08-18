export const formatProof = (proof, requestData) => {
  let formattedProof = {
    identifier: proof.claim.identifier,
    claimData: proof.claim,
    signatures: [toHexString(proof.signatures.claimSignature)],
    witnesses: [
      {
        id: proof.signatures.attestorAddress,
        url: "wss://attestor.reclaimprotocol.org/ws",
      },
    ],
    taskId: null,
    publicData: null,
    providerRequest: requestData,
  };
  return formattedProof;
};

const toHexString = (signatureObject) => {
  if (!signatureObject) {
    return "";
  }
  // Convert an object {0: byte0, 1: byte1, ...} to a hex string
  const hexString = Object.values(signatureObject)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hexString}`;
};
