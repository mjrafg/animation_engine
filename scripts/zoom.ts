/** Dev helper: tsx scripts/zoom.ts in.png out.png left top width height factor [bgColor] */
import sharp from "sharp";
async function main() {
  const [inp, out, l, t, w, h, f, bg] = process.argv.slice(2);
  const img = sharp(inp).extract({ left: +l, top: +t, width: +w, height: +h });
  const buf = await (bg ? img.flatten({ background: bg }) : img).png().toBuffer();
  await sharp(buf).resize({ width: +w * +f, kernel: "nearest" }).png().toFile(out);
}
main();
