import { toBigIntBE, toBufferBE } from 'bigint-buffer';

import { EthAddress } from '../../address';
import { Pedersen } from '../../crypto/pedersen';
import { Note } from '../note';
import { NoteAlgorithms } from '../note_algorithms';
import { numToUInt32BE } from '../../serialize';

export function computeSigningData(
    notes: Note[],
    inputNote1Index: number,
    inputNote2Index: number,
    inputOwner: EthAddress,
    outputOwner: EthAddress,
    inputValue: bigint,
    outputValue: bigint,
    assetId: number,
    numInputNotes: number,
    nullifierKey: Buffer,
    pedersen: Pedersen,
    noteAlgos: NoteAlgorithms,
) {

    const encryptedNotes = notes.map(note => noteAlgos.encryptNote(note));

    const nullifier1 = noteAlgos.computeNoteNullifier(encryptedNotes[0], inputNote1Index, nullifierKey, numInputNotes >= 1);
    const nullifier2 = noteAlgos.computeNoteNullifier(encryptedNotes[1], inputNote2Index, nullifierKey, numInputNotes >= 2);

    const toCompress = [
        toBufferBE(inputValue, 32),
        toBufferBE(outputValue, 32),
        numToUInt32BE(assetId, 32),
        ...encryptedNotes.slice(2).map(note => [note.slice(0, 32), note.slice(32, 64)]).flat(),
        nullifier1,
        nullifier2,
        Buffer.concat([Buffer.alloc(12), inputOwner.toBuffer()]),
        Buffer.concat([Buffer.alloc(12), outputOwner.toBuffer()]),
    ];
    return pedersen.compressInputs(toCompress);
}
