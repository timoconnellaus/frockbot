const CHUNK_SIZE_CHARS = 1600;
const OVERLAP_CHARS = 320;

export interface MemoryChunk {
  content: string;
  startLine: number;
  endLine: number;
  hash: string;
}

interface LineRange {
  text: string;
  startLine: number;
  endLine: number;
}

export async function hashMemoryContent(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function paragraphs(lines: string[]): LineRange[] {
  const result: LineRange[] = [];
  let block: string[] = [];
  let startLine = -1;
  const flush = (endLine: number) => {
    if (block.length === 0) return;
    result.push({ text: block.join("\n"), startLine, endLine });
    block = [];
    startLine = -1;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim()) {
      if (startLine === -1) startLine = index + 1;
      block.push(line);
    } else {
      flush(index);
    }
  }
  flush(lines.length);
  return result;
}

function splitOversized(range: LineRange): LineRange[] {
  if (range.text.length <= CHUNK_SIZE_CHARS) return [range];
  const result: LineRange[] = [];
  const step = CHUNK_SIZE_CHARS - OVERLAP_CHARS;
  for (let offset = 0; offset < range.text.length; offset += step) {
    const text = range.text.slice(offset, offset + CHUNK_SIZE_CHARS).trim();
    if (text) result.push({ ...range, text });
    if (offset + CHUNK_SIZE_CHARS >= range.text.length) break;
  }
  return result;
}

export async function chunkMarkdown(content: string): Promise<MemoryChunk[]> {
  if (!content.trim()) return [];
  const blocks = paragraphs(content.split("\n")).flatMap(splitOversized);
  const chunks: MemoryChunk[] = [];
  let index = 0;
  while (index < blocks.length) {
    let text = "";
    const startLine = blocks[index]?.startLine ?? 1;
    let endLine = blocks[index]?.endLine ?? startLine;
    let cursor = index;
    while (cursor < blocks.length) {
      const block = blocks[cursor];
      if (!block) break;
      const addition = text ? `\n\n${block.text}` : block.text;
      if (text && text.length + addition.length > CHUNK_SIZE_CHARS) break;
      text += addition;
      endLine = block.endLine;
      cursor += 1;
    }
    const normalized = text.trim();
    if (normalized) {
      chunks.push({
        content: normalized,
        startLine,
        endLine,
        hash: await hashMemoryContent(normalized),
      });
    }
    if (cursor >= blocks.length) break;
    let overlap = 0;
    let next = cursor;
    for (
      let candidate = cursor - 1;
      candidate > index && overlap < OVERLAP_CHARS;
      candidate -= 1
    ) {
      overlap += (blocks[candidate]?.text.length ?? 0) + 2;
      next = candidate;
    }
    index = next <= index ? cursor : next;
  }
  return chunks;
}
