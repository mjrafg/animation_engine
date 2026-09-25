/** Dev helper: tsx scripts/contact-sheet.ts out.png img1.png img2.png ... (images over a grey checker) */
import sharp from "sharp";

async function main() {
  const [out, ...files] = process.argv.slice(2);
  const H = Number(process.env.SHEET_HEIGHT ?? 360);
  const bg = process.env.SHEET_BG ?? "#888888";
  const imgs = await Promise.all(
    files.map(async (f) => {
      const b = await sharp(f).resize({ height: H, width: 600, fit: "inside" }).flatten({ background: bg }).png().toBuffer();
      const m = await sharp(b).metadata();
      return { b, w: m.width! };
    }),
  );
  let x = 0;
  const comps = imgs.map((i) => {
    const c = { input: i.b, left: x, top: 0 };
    x += i.w + 10;
    return c;
  });
  await sharp({ create: { width: x, height: H, channels: 4, background: bg } }).composite(comps).png().toFile(out);
}
main();
