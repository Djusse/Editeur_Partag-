/**
 * Comptage des caractères d'un update Yjs, **sans reconstruire de Y.Doc**.
 *
 * C'est la brique qui rend la contrainte C4 (crédit) incontournable côté
 * serveur : le client ne peut pas mentir sur le nombre de caractères qu'il a
 * écrits, puisque le serveur relit la structure binaire de l'update.
 *
 * Référence : Yjs v13, `src/utils/encoding.js` et `src/structs/*.js`,
 * encodage v1 (`encodeStateAsUpdate` / delta d'update).
 *
 * update := numClients, [ numStructs, client, clock, struct* ]*, deleteSet
 *   struct := info(uint8), [originID], [rightOriginID], [parentInfo], content
 *   info bits : 0-4 ref de contenu, 32 = parentSub non nul,
 *               64 = rightOrigin défini, 128 = origin défini
 *   refs de contenu : 0 GC | 1 ContentDeleted | 2 ContentJSON | 3 ContentBinary
 *                     4 ContentString | 5 ContentEmbed | 6 ContentFormat
 *                     7 ContentType | 9 ContentDoc
 *   parentInfo : 1 = clé racine (string), 0 = ID de l'item parent
 *   deleteSet := numClients, [ client, numRanges, (clock, length)* ]*
 *
 * Règle de facturation retenue (documentée en ADR) : l'expéditeur authentifié
 * est facturé de **tous** les caractères insérés et supprimés par l'update,
 * quel que soit le `clientID` qui a produit les structs.
 */
import * as decoding from 'lib0/decoding';

export interface UpdateCounts {
  /** Caractères insérés (somme des longueurs des ContentString). */
  inserted: number;
  /** Caractères supprimés (somme des longueurs des plages du delete set). */
  deleted: number;
  /** Nombre de structs lues (diagnostic). */
  structs: number;
}

export class InvalidUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUpdateError';
  }
}

const REF_GC = 0;
const REF_DELETED = 1;
const REF_JSON = 2;
const REF_BINARY = 3;
const REF_STRING = 4;
const REF_EMBED = 5;
const REF_FORMAT = 6;
const REF_TYPE = 7;
const REF_DOC = 9;
/** `Skip` n'a pas de ref de contenu : Yjs teste `info === 10`. */
const REF_SKIP = 10;

const BIT_ORIGIN = 128;
const BIT_RIGHT_ORIGIN = 64;
const BIT_PARENT_SUB = 32;
const BITS5 = 31;

function readId(decoder: decoding.Decoder): void {
  decoding.readVarUint(decoder); // client
  decoding.readVarUint(decoder); // clock
}

/** Lit le contenu d'un Item et renvoie le nombre de caractères insérés. */
function readContent(decoder: decoding.Decoder, contentRef: number): number {
  switch (contentRef) {
    case 0: // GC : writeInfo(0) + writeLen
      decoding.readVarUint(decoder);
      return 0;
    case REF_DELETED: // ContentDeleted : writeLen
      decoding.readVarUint(decoder);
      return 0;
    case REF_JSON: {
      // ContentJSON : writeLen puis un writeString par élément
      const count = decoding.readVarUint(decoder);
      for (let i = 0; i < count; i++) decoding.readVarString(decoder);
      return 0;
    }
    case REF_BINARY: // ContentBinary : writeBuf
      decoding.readVarUint8Array(decoder);
      return 0;
    case REF_STRING: {
      // ContentString : c'est ici que se trouvent les caractères facturés
      const text = decoding.readVarString(decoder);
      return text.length;
    }
    case REF_EMBED: // ContentEmbed : writeJSON
      decoding.readVarString(decoder);
      return 0;
    case REF_FORMAT: // ContentFormat : writeKey + writeJSON
      decoding.readVarString(decoder);
      decoding.readVarString(decoder);
      return 0;
    case REF_TYPE: // ContentType : _write(encoder) (type concret, non facturé)
      decodeAbstractType(decoder);
      return 0;
    case REF_DOC: // ContentDoc : writeString(guid) + writeAny(opts)
      decoding.readVarString(decoder);
      decoding.readAny(decoder);
      return 0;
    default:
      throw new InvalidUpdateError(`Type de contenu inconnu : ${contentRef}`);
  }
}

/**
 * Un ContentType écrit d'abord l'identifiant du type concret (`writeTypeRef`),
 * puis éventuellement un nom :
 *   0 YArray | 1 YMap | 2 YText | 3 YXmlElement (+nodeName) | 4 YXmlFragment
 *   5 YXmlHook (+hookName) | 6 YXmlText
 * Ces structs n'apparaissent pas dans un `Y.Text` simple ; on les consomme
 * pour rester tolérant plutôt que de rejeter un document contenant un sous-type.
 */
function decodeAbstractType(decoder: decoding.Decoder): void {
  const typeRef = decoding.readVarUint(decoder);
  if (typeRef === 3 || typeRef === 5) {
    decoding.readVarString(decoder); // nodeName / hookName
  } else if (typeRef > 6) {
    throw new InvalidUpdateError(`Type de sous-document inconnu : ${typeRef}`);
  }
}

export function countUpdate(update: Uint8Array): UpdateCounts {
  let structs = 0;
  let inserted = 0;
  let deleted = 0;

  if (!(update instanceof Uint8Array) || update.length === 0) {
    throw new InvalidUpdateError('Update vide');
  }

  const decoder = decoding.createDecoder(update);
  try {
    const clientCount = decoding.readVarUint(decoder);
    if (clientCount > 100000) throw new InvalidUpdateError('Trop de clients dans l\'update');

    for (let clientIndex = 0; clientIndex < clientCount; clientIndex++) {
      let structCount = decoding.readVarUint(decoder);
      if (structCount > 100000) throw new InvalidUpdateError('Trop de structs dans l\'update');
      decoding.readVarUint(decoder); // client
      decoding.readVarUint(decoder); // clock

      while (structCount-- > 0) {
        const info = decoding.readUint8(decoder);
        structs++;
        const contentRef = info & BITS5;
        if (contentRef === REF_GC || contentRef === REF_SKIP) {
          // GC / Skip : writeInfo puis writeLen (VarUint)
          decoding.readVarUint(decoder);
          continue;
        }
        // Item
        if ((info & BIT_ORIGIN) !== 0) {
          readId(decoder); // origin
          if ((info & BIT_RIGHT_ORIGIN) !== 0) readId(decoder); // rightOrigin
        } else {
          const hasRightOrigin = (info & BIT_RIGHT_ORIGIN) !== 0;
          if (hasRightOrigin) readId(decoder); // rightOrigin
          if (!hasRightOrigin) {
            // L'item est accroché par son parent : writeParentInfo(true) => 1
            // (clé racine, string), false => 0 (ID de l'item parent).
            const isRootKey = decoding.readVarUint(decoder) === 1;
            if (isRootKey) {
              decoding.readVarString(decoder);
            } else {
              readId(decoder);
            }
            if ((info & BIT_PARENT_SUB) !== 0) decoding.readVarString(decoder);
          }
        }
        inserted += readContent(decoder, contentRef);
      }
    }

    const deleteClientCount = decoding.readVarUint(decoder);
    if (deleteClientCount > 100000) throw new InvalidUpdateError('Trop de clients dans le delete set');
    for (let i = 0; i < deleteClientCount; i++) {
      decoding.readVarUint(decoder); // client
      const rangeCount = decoding.readVarUint(decoder);
      for (let r = 0; r < rangeCount; r++) {
        decoding.readVarUint(decoder); // clock
        deleted += decoding.readVarUint(decoder); // longueur de la plage
      }
    }

    if (decoding.hasContent(decoder)) {
      throw new InvalidUpdateError('Octets résiduels à la fin de l\'update');
    }
  } catch (error) {
    if (error instanceof InvalidUpdateError) throw error;
    throw new InvalidUpdateError(`Update Yjs illisible : ${(error as Error).message}`);
  }

  return { inserted, deleted, structs };
}

/** Coût en crédit : insertions + suppressions. */
export function creditCost(update: Uint8Array): { cost: number; counts: UpdateCounts } {
  const counts = countUpdate(update);
  return { cost: counts.inserted + counts.deleted, counts };
}
