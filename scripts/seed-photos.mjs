// Copy Participants/*.jpeg -> public/photos/*.jpg (ascii names, max 800px).
// Idempotent. Run: node scripts/seed-photos.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(root, 'Participants');
const DEST = path.join(root, 'public', 'photos');
fs.mkdirSync(DEST, { recursive: true });

// team dir -> ascii slug + side mapping (boy file / girl file)
const MAP = [
  { dir: 'Cabaret',      slug: 'cabaret',    boy: 'Croitoru David.jpeg',  girl: 'Armașu Diana.jpeg' },
  { dir: 'Circ',         slug: 'circ',       boy: 'Ionescu Ștefan.jpeg',  girl: 'Sofronea Ștefania.jpeg' },
  { dir: 'Detectiv',     slug: 'detectivi',  boy: 'Luca Adrian.jpeg',     girl: 'Lungu Delia.jpeg' },
  { dir: 'Disco',        slug: 'disco',      boy: 'Andrei Antonio.jpeg',  girl: 'Ialâi Daniela.jpeg' },
  { dir: 'Lux',          slug: 'lux',        boy: 'Atasiei Andrei.jpeg',   girl: 'David Sofia.jpeg' },
  { dir: 'Noapte Magica', slug: 'noapte',    boy: 'Dogaru David.jpeg',    girl: 'Ignat Diana.jpeg' },
  { dir: 'Teatru',       slug: 'teatru',     boy: 'Pălie Mihnea.jpeg',    girl: 'Cuceanu Ruxi.jpeg' },
];

let ok = 0, missing = [];
for (const m of MAP) {
  for (const side of ['boy', 'girl']) {
    const src = path.join(SRC, m.dir, m[side]);
    const dest = path.join(DEST, `${m.slug}-${side}.jpg`);
    if (!fs.existsSync(src)) { missing.push(src); continue; }
    if (fs.existsSync(dest)) { ok++; continue; } // keep existing (admin may have replaced? no—seed dest separate)
    await sharp(src).rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(dest);
    console.log('seeded', path.basename(dest));
    ok++;
  }
}
console.log(`[seed-photos] done: ${ok} photos.`);
if (missing.length) { console.error('[seed-photos] MISSING:'); for (const f of missing) console.error('  ' + f); process.exit(1); }
