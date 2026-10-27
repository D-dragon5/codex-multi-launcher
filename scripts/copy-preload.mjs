import fs from "node:fs/promises";

const source = new URL("../src/preload/index.cjs", import.meta.url);
const target = new URL("../dist-electron/preload/index.cjs", import.meta.url);
await fs.mkdir(new URL("./", target), { recursive: true });
await fs.copyFile(source, target);
