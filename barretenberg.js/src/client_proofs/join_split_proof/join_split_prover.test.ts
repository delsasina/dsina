import { JoinSplitProver, JoinSplitVerifier } from './index';
import createDebug from 'debug';
import { BarretenbergWasm } from '../../wasm';
import { JoinSplitTx } from './join_split_tx';
import { MerkleTree } from '../../merkle_tree';
import levelup from 'levelup';
import memdown from 'memdown';
import { Pedersen } from '../../crypto/pedersen';
import { Note, createNoteSecret } from '../note';
import { EventEmitter } from 'events';
import { Crs } from '../../crs';
import { WorkerPool } from '../../wasm/worker_pool';
import { PooledPippenger } from '../../pippenger';
import { PooledFft } from '../../fft';
import { ProofData } from '../proof_data';
import { Grumpkin } from '../../ecc/grumpkin';
import { NoteAlgorithms } from '../note_algorithms';
import { GrumpkinAddress, EthAddress } from '../../address';
import { Schnorr } from '../../crypto/schnorr';
import { UnrolledProver } from '../prover';
import { computeSigningData } from './compute_signing_data';
import { Blake2s } from '../../crypto/blake2s';
import { AccountId } from '../account_id';
import { AliasHash } from '../alias_hash';

const debug = createDebug('bb:join_split_proof_test');

jest.setTimeout(120000);

describe('join_split_proof', () => {
  let barretenberg!: BarretenbergWasm;
  let pool!: WorkerPool;
  let joinSplitProver!: JoinSplitProver;
  let joinSplitVerifier!: JoinSplitVerifier;
  let blake2s!: Blake2s;
  let pedersen!: Pedersen;
  let schnorr!: Schnorr;
  let crs!: Crs;
  let pippenger!: PooledPippenger;
  let grumpkin!: Grumpkin;
  let noteAlgos!: NoteAlgorithms;
  let pubKey!: GrumpkinAddress;

  // prettier-ignore
  const privateKey = Buffer.from([
    0x0b, 0x9b, 0x3a, 0xde, 0xe6, 0xb3, 0xd8, 0x1b, 0x28, 0xa0, 0x88, 0x6b, 0x2a, 0x84, 0x15, 0xc7,
    0xda, 0x31, 0x29, 0x1a, 0x5e, 0x96, 0xbb, 0x7a, 0x56, 0x63, 0x9e, 0x17, 0x7d, 0x30, 0x1b, 0xeb ]);

  beforeAll(async () => {
    EventEmitter.defaultMaxListeners = 32;
    const circuitSize = JoinSplitProver.circuitSize;

    crs = new Crs(circuitSize);
    await crs.download();

    barretenberg = await BarretenbergWasm.new();

    pool = new WorkerPool();
    await pool.init(barretenberg.module, Math.min(navigator.hardwareConcurrency, 8));

    pippenger = new PooledPippenger();
    await pippenger.init(crs.getData(), pool);

    const fft = new PooledFft(pool);
    await fft.init(circuitSize);

    const prover = new UnrolledProver(pool.workers[0], pippenger, fft);

    blake2s = new Blake2s(barretenberg);
    pedersen = new Pedersen(barretenberg);
    schnorr = new Schnorr(barretenberg);
    grumpkin = new Grumpkin(barretenberg);
    noteAlgos = new NoteAlgorithms(barretenberg);
    joinSplitProver = new JoinSplitProver(prover);
    joinSplitVerifier = new JoinSplitVerifier();

    pubKey = new GrumpkinAddress(grumpkin.mul(Grumpkin.one, privateKey));
  });

  afterAll(async () => {
    await pool.destroy();
  });

  describe('join_split_proof_generation', () => {
    beforeAll(async () => {
      debug('creating keys...');
      const start = new Date().getTime();
      await joinSplitProver.computeKey();
      await joinSplitVerifier.computeKey(pippenger.pool[0], crs.getG2Data());
      debug(`created circuit keys: ${new Date().getTime() - start}ms`);
    });

    it('should get key data', async () => {
      const provingKey = await joinSplitProver.getKey();
      expect(provingKey.length).toBeGreaterThan(0);

      const verificationKey = await joinSplitVerifier.getKey();
      expect(verificationKey.length).toBeGreaterThan(0);
    });

    it('should construct join split proof', async () => {
      const inputNote1 = new Note(pubKey, createNoteSecret(), BigInt(100), 0, 0);
      const inputNote2 = new Note(pubKey, createNoteSecret(), BigInt(50), 0, 0);
      const outputNote1 = new Note(pubKey, createNoteSecret(), BigInt(80), 0, 0);
      const outputNote2 = new Note(pubKey, createNoteSecret(), BigInt(70), 0, 0);

      const inputNote1Enc = await noteAlgos.encryptNote(inputNote1);
      const inputNote2Enc = await noteAlgos.encryptNote(inputNote2);

      const tree = new MerkleTree(levelup(memdown()), pedersen, 'data', 32);
      await tree.updateElement(0, inputNote1Enc);
      await tree.updateElement(1, inputNote2Enc);

      const inputNote1Path = await tree.getHashPath(0);
      const inputNote2Path = await tree.getHashPath(1);
      const accountNotePath = await tree.getHashPath(2);

      const aliasHash = AliasHash.fromAlias('user_zero', blake2s);
      const nonce = 0;
      const accountId = new AccountId(aliasHash, nonce);

      const inputOwner = EthAddress.randomAddress();
      const outputOwner = EthAddress.randomAddress();

      const numInputNotes = 2;
      const sigMsg = computeSigningData(
        [inputNote1, inputNote2, outputNote1, outputNote2],
        0,
        1,
        inputOwner,
        outputOwner,
        BigInt(0),
        BigInt(0),
        0,
        numInputNotes,
        privateKey,
        pedersen,
        noteAlgos,
      );
      const signature = schnorr.constructSignature(sigMsg, privateKey);

      const tx = new JoinSplitTx(
        BigInt(0),
        BigInt(0),
        0,
        numInputNotes,
        [0, 1],
        tree.getRoot(),
        [inputNote1Path, inputNote2Path],
        [inputNote1, inputNote2],
        [outputNote1, outputNote2],
        privateKey,
        accountId,
        2,
        accountNotePath,
        pubKey,
        signature,
        inputOwner,
        outputOwner,
      );

      const expectedNullifier1 = noteAlgos.computeNoteNullifier(inputNote1Enc, 0, privateKey);
      const expectedNullifier2 = noteAlgos.computeNoteNullifier(inputNote2Enc, 1, privateKey);

      debug('creating proof...');
      const start = new Date().getTime();
      const proof = await joinSplitProver.createProof(tx);
      debug(`created proof: ${new Date().getTime() - start}ms`);
      debug(`proof size: ${proof.length}`);

      const verified = await joinSplitVerifier.verifyProof(proof);
      expect(verified).toBe(true);

      const joinSplitProof = new ProofData(proof, []);
      expect(joinSplitProof.nullifier1).toEqual(expectedNullifier1);
      expect(joinSplitProof.nullifier2).toEqual(expectedNullifier2);
      expect(joinSplitProof.inputOwner).toEqual(inputOwner.toBuffer32());
      expect(joinSplitProof.outputOwner).toEqual(outputOwner.toBuffer32());
    });
  });
});
