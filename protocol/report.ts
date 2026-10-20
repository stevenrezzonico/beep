import { writeFileSync } from 'node:fs';
import { encodeMessage, MAX_PACKET_BYTES } from './message.ts';
import { DEFAULT_CONFIG, describe } from '../modem/profiles.ts';
import { airTime } from '../modem/tx.ts';

/**
 * Worked examples for docs/PROTOCOL.md: bits, packets and air time per profile for typical
 * messages. Run: npx tsx protocol/report.ts (writes protocol/report.md).
 */
const examples: { label: string; content: Parameters<typeof encodeMessage>[0] }[] = [
  { label: 'chat: "On my way, be there in 15 min"', content: { kind: 'text', text: 'On my way, be there in 15 min' } },
  { label: 'Wi-Fi: "WiFi: Guest-Net-2.4 / pass: blueberry77"', content: { kind: 'text', text: 'WiFi: Guest-Net-2.4 / pass: blueberry77' } },
  { label: 'URL: "https://example.com/r/8fK2"', content: { kind: 'text', text: 'https://example.com/r/8fK2' } },
  { label: '280-char paragraph', content: { kind: 'text', text: 'The meeting moved to Thursday at 3pm in the small conference room. Please bring the printed agenda, your laptop and the budget numbers we discussed last week. If you cannot make it, send me a short note before noon so I can update the list. Coffee will be ready at 2:45.' } },
  { label: '1 KB binary file', content: { kind: 'file', name: 'data.bin', data: new Uint8Array(1024).map((_, i) => (i * 37) & 255) } },
  { label: '4 KB binary file', content: { kind: 'file', name: 'data.bin', data: new Uint8Array(4096).map((_, i) => (i * 37) & 255) } },
];

const d = describe();
const out: string[] = [];
out.push(`Preamble ${DEFAULT_CONFIG.nUp}↑+${DEFAULT_CONFIG.nDown}↓ SF${DEFAULT_CONFIG.sfPre} = ${d.preambleSec.toFixed(2)} s, header ${DEFAULT_CONFIG.nHeader} chirps = ${((DEFAULT_CONFIG.nHeader * (1 << DEFAULT_CONFIG.sfPre)) / d.bw).toFixed(2)} s per packet.`);
out.push('');
out.push('| Message | profile | content bits | packets (k + repair) | air time (s) | effective bit/s |');
out.push('|---|---|---|---|---|---|');
for (const ex of examples) {
  for (const p of DEFAULT_CONFIG.profiles) {
    const m = encodeMessage(ex.content, { maxPacket: MAX_PACKET_BYTES[p.name], id: 1, repairRatio: 0.25 });
    const t = m.payloads.reduce((a, pl) => a + airTime(pl.length, p), 0);
    const bytes = ex.content.kind === 'text' ? new TextEncoder().encode(ex.content.text).length : ex.content.data.length;
    out.push(`| ${ex.label} | ${p.name} | ${m.contentBits} | ${m.fragmented ? `${m.k} + ${m.payloads.length - m.k}` : '1'} | ${t.toFixed(1)} | ${((bytes * 8) / t).toFixed(1)} |`);
  }
}
writeFileSync(new URL('./report.md', import.meta.url), out.join('\n') + '\n');
console.log(out.join('\n'));
