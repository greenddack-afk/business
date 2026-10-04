// content/skills/*.md → lib/generated/skills.ts. 서버리스 번들에 파일 읽기 없이 들어가도록 문자열로 굳힌다.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../content/skills/", import.meta.url);
const out = new URL("../lib/generated/skills.ts", import.meta.url);
const skills = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
  skills[f.replace(/\.md$/, "")] = readFileSync(new URL(f, dir), "utf8").replace(/\r\n/g, "\n");
}
const body = `// 자동 생성 파일 — content/skills/*.md를 고친 뒤 \`npm run gen\`. 직접 고치지 말 것.\nexport const SKILLS: Record<string, string> = ${JSON.stringify(skills, null, 2)};\n`;
writeFileSync(out, body);
console.log(`skills: ${Object.keys(skills).join(", ")} → ${join("lib", "generated", "skills.ts")}`);
