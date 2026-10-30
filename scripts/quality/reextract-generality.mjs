#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readArtifactReport, writeArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { parseJsonlDiagnostics } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { extractGeneralityMarkers, summarizeGenerality } from '../../coordinator/src/benchmark/generality-suite.mjs';
export async function reextractSuite(input, out) {
 const report=await readArtifactReport(input);
 for(const run of report.runs) {
  if(!run.artifacts||!run.metrics) continue;
  const artifacts=path.isAbsolute(run.artifacts)?run.artifacts:path.resolve(path.dirname(input),run.artifacts);
  run.artifacts=artifacts;
  const samples=JSON.parse(await readFile(path.join(artifacts,'quality-samples.json'),'utf8')).samples;
  const protocolRows=parseJsonlDiagnostics(await readFile(path.join(artifacts,'quality-protocol.jsonl'),'utf8')).rows;
  run.markers=extractGeneralityMarkers({scenario:{...run.definition,fixtureActivatedAt:run.setup?.activatedAt,setup:run.setup?.definition??run.definition.setup},metrics:run.metrics,samples,protocolRows});
 }
 report.summary=summarizeGenerality(report.runs);report.reextraction={at:new Date().toISOString(),sourceReport:path.resolve(input),extractorSha256:createHash('sha256').update(await readFile(new URL('../../coordinator/src/benchmark/generality-suite.mjs',import.meta.url))).digest('hex')};
 await mkdir(out,{recursive:true});await writeArtifactReport(path.join(out,'results.json'),report);
 return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {if(process.argv.length!==4)throw new Error('reextract-generality.mjs REPORT.json NEW_OUTPUT_DIR');await reextractSuite(process.argv[2],path.resolve(process.argv[3]));}catch(e){console.error(e);process.exitCode=1;}
}
