import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runWebsiteAgent } from '../src/website-react.js';
import type { WebsiteSnapshot } from '../src/website-html.js';
import type { WebsiteAgentEvent } from '../src/website-agent-types.js';
import { ApiError } from '../src/errors.js';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const output = new URL('../../outputs/local-tests/', import.meta.url);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const measured: NonNullable<WebsiteAgentEvent['model_call']>[] = [];
  let progress: unknown, htmlFile: string | null = null, failure: string | null = null;
  let source: { id: string; requesting_user_id: string; restaurant_id: string; input: { brief: string }; snapshot: WebsiteSnapshot } | undefined;
  const started = Date.now();
  let diagnostics: unknown[] = [];
  try {
    // Only the most recent failed generation: do not silently repeat multiple paid runs or publish.
    source = (await pool.query(`SELECT id,requesting_user_id,restaurant_id,input,snapshot FROM website_jobs
      WHERE kind='generate' AND status='failed' AND error_code='AGENT_TOKEN_LIMIT' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    if (!source) throw new ApiError(503, 'FAILED_RUN_NOT_FOUND');
    const authorized = async () => {
      const rows = await pool.query(`SELECT r.id FROM restaurants r JOIN restaurant_members m ON m.restaurant_id=r.id
        JOIN users u ON u.id=m.user_id WHERE r.id=$1 AND m.user_id=$2 AND m.role='owner' AND m.status='active'
        AND u.status='active' AND u.email_verified_at IS NOT NULL AND r.status IN ('draft','active')`, [source!.restaurant_id, source!.requesting_user_id]);
      if (!rows.rowCount) throw new ApiError(503, 'WEBSITE_CONTEXT_REVOKED');
    };
    await authorized();
    const result = await runWebsiteAgent(config, source.input.brief, source.snapshot, async observation => {
      progress = observation.progress;
      if (observation.event.action === 'model_call_started') await authorized();
      if (observation.event.model_call && observation.event.model_call.status !== 'started') {
        measured.push(observation.event.model_call);
        process.stdout.write(JSON.stringify(observation.event.model_call) + '\n');
      }
      if (observation.event.action === 'validate_draft') {
        diagnostics = observation.event.diagnostics;
        process.stdout.write(JSON.stringify({ action: 'validate_draft', ok: observation.event.status === 'ok', round: observation.progress.round, diagnostic_codes: observation.event.diagnostics.map(item => item.code) }) + '\n');
      }
      await writeFile(new URL('website-run-measurement.json', output), JSON.stringify({ model: config.website?.model, mode: 'usage_observation', status: 'running', calls: measured, progress, elapsed_ms: Date.now() - started, published: false }, null, 2), { mode: 0o600 });
    }, undefined, controller.signal);
    await authorized();
    htmlFile = fileURLToPath(new URL('Chome-生成实测.html', output));
    await writeFile(htmlFile, result.html, { mode: 0o600 });
  } catch (error) {
    failure = error instanceof ApiError ? error.code : 'MEASUREMENT_FAILED';
    process.exitCode = 1;
  } finally {
    await pool.end();
    const known = measured.filter(call => call.total_tokens !== null);
    const report = { source_job_id: source?.id ?? null, model: config.website?.model, mode: 'usage_observation', status: failure ? 'failed' : 'succeeded', error_code: failure, model_calls: measured.length,
      totals: { prompt_tokens: known.reduce((n,c) => n + c.prompt_tokens!,0), completion_tokens: known.reduce((n,c) => n + c.completion_tokens!,0), total_tokens: known.reduce((n,c) => n + c.total_tokens!,0) },
      unknown_usage_calls: measured.length - known.length, elapsed_ms: Date.now() - started, draft_rounds: (progress as { round?: number } | undefined)?.round ?? 0, diagnostics, calls: measured, html_file: htmlFile, database_modified: false, published: false };
    await writeFile(new URL('website-run-measurement.json', output), JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + '\n');
  }
}
main().catch(() => { process.stderr.write('实测环境或来源不可用，未发起更多模型调用\n'); process.exitCode = 1; });
