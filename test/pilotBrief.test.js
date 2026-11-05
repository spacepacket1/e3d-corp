import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectBrief, renderText, renderHtml } from '../ops/reports/pilotBrief.js';

test('pilot brief renders on an empty instance without internals or ops noise', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-brief-'));
  try {
    const c = collectBrief({ dataDir, now: new Date('2026-11-04T15:00:00Z') });
    const text = renderText(c, 'Wed, Nov 4, 2026');
    const html = renderHtml(c, 'Wed, Nov 4, 2026');
    assert.match(text, /quiet day/);
    assert.match(text, /reply to this email/);
    for (const banned of [/localhost/, /e3d-corp opportunities/, /CUMULATIVE/i, /\bid [0-9a-f]{8}\b/]) {
      assert.doesNotMatch(text, banned);
      assert.doesNotMatch(html, banned);
    }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
