/** Writes schema/scene.schema.json (JSON Schema generated from the Zod scene schema). */
import fs from "node:fs";
import { z } from "zod";
import { SceneSchema } from "../src/scene/schema.js";

const schema = z.toJSONSchema(SceneSchema, { io: "input" });
fs.mkdirSync("schema", { recursive: true });
fs.writeFileSync(
  "schema/scene.schema.json",
  JSON.stringify({ $id: "animation-engine/scene.schema.json", title: "Scene", ...schema }, null, 2) + "\n",
);
console.log("wrote schema/scene.schema.json");
