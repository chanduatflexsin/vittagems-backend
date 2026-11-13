import { ResilientNonceSigner } from "../../src/blockchain/ResilientNonceSigner";

describe("ResilientNonceSigner", () => {
  it("serializes concurrent transactions and fetches network pending nonce", async () => {
    let callCount = 0;
    const sentNonces: number[] = [];

    const mockSigner = {
      getNonce: jest.fn().mockImplementation(async () => {
        return 100 + callCount++;
      }),
      populateTransaction: jest.fn().mockImplementation(async (tx) => ({ ...tx })),
      sendTransaction: jest.fn().mockImplementation(async (tx) => {
        sentNonces.push(tx.nonce);
        return { hash: `0xhash_${tx.nonce}`, wait: jest.fn().mockResolvedValue({}) };
      }),
    };

    const resilientSigner = new ResilientNonceSigner(mockSigner as any);

    // Call concurrently
    const [tx1, tx2] = await Promise.all([
      resilientSigner.sendTransaction({ to: "0x1" }),
      resilientSigner.sendTransaction({ to: "0x2" }),
    ]);

    expect(sentNonces).toEqual([100, 101]);
    expect(tx1.hash).toBe("0xhash_100");
    expect(tx2.hash).toBe("0xhash_101");
  });

  it("re-syncs and retries on gapped-nonce or nonce desync error", async () => {
    let attempts = 0;
    const mockSigner = {
      getNonce: jest.fn().mockResolvedValue(105),
      populateTransaction: jest.fn().mockImplementation(async (tx) => ({ ...tx })),
      sendTransaction: jest.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          const err: any = new Error("could not coalesce error");
          err.error = { code: -32000, message: "gapped-nonce tx from delegated accounts" };
          throw err;
        }
        return { hash: "0xrecovered_hash", wait: jest.fn().mockResolvedValue({}) };
      }),
    };

    const resilientSigner = new ResilientNonceSigner(mockSigner as any);
    const res = await resilientSigner.sendTransaction({ to: "0x1" });

    expect(attempts).toBe(2);
    expect(res.hash).toBe("0xrecovered_hash");
  });
});

