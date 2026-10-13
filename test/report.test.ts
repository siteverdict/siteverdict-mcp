import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureItems } from '../src/apify/mock.js';
import {
  buildFixPlan, deriveScore, gradeFor, mapSeverity, normaliseItems, overallScore, pickScore, priorityScore, type Finding,
} from '../src/report.js';

test('severity mapping covers axe and generic vocabularies', () => {
  assert.equal(mapSeverity('serious'), 'high');
  assert.equal(mapSeverity('moderate'), 'medium');
  assert.equal(mapSeverity('minor'), 'low');
  assert.equal(mapSeverity('CRITICAL'), 'critical');
  assert.equal(mapSeverity(9.5), 'critical');
  assert.equal(mapSeverity(undefined), 'info');
});

test('normalises tracking-consent Actor shape (one item per URL with findings[])', () => {
  const { summaryItem, findings } = normaliseItems(fixtureItems('tracking_consent', 'https://a.com/'), 'tracking_consent');
  assert.ok(summaryItem);
  assert.equal(pickScore(summaryItem), (summaryItem as { score: number }).score);
  assert.equal(findings.length, 5);
  assert.equal(findings[0]!.category, 'consent');
  assert.deepEqual(findings[0]!.pages, ['https://a.com/']);
});

test('normalises summary + finding items shape', () => {
  const { summaryItem, findings } = normaliseItems(fixtureItems('speed_revenue', 'https://a.com/'), 'speed_revenue');
  assert.equal((summaryItem as { type: string }).type, 'summary');
  assert.equal(findings.length, 4);
  assert.match(findings[0]!.impact ?? '', /revenue at risk/);
});

test('normalises axe-core violations shape', () => {
  const { findings } = normaliseItems(fixtureItems('accessibility', 'https://a.com/'), 'accessibility');
  const label = findings.find((f) => f.id === 'label')!;
  assert.equal(label.severity, 'critical');
  assert.equal(label.category, 'accessibility');
  assert.match(label.standard ?? '', /wcag412/);
  assert.ok(label.helpUrl);
});

test('dedupes findings and keeps the worst severity', () => {
  const { findings } = normaliseItems(
    [{ findings: [{ id: 'x', title: 'Same issue', severity: 'low', url: 'https://a.com/1' }, { id: 'x', title: 'Same  issue!', severity: 'high', url: 'https://a.com/2' }] }],
    'ai_search',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'high');
  assert.equal(findings[0]!.pages?.length, 2);
});

test('scores: 0..1 scaled, derived, graded', () => {
  assert.equal(pickScore({ score: 0.83 }), 83);
  assert.equal(pickScore({ scores: { overall: 71 } }), 71);
  assert.equal(pickScore({}), null);
  const f = (severity: Finding['severity']): Finding => ({ id: severity, title: severity, severity, category: 'other' });
  assert.equal(deriveScore([f('critical'), f('high'), f('medium')]), 69);
  assert.equal(deriveScore(Array(10).fill(f('critical'))), 0);
  assert.equal(gradeFor(90), 'A');
  assert.equal(gradeFor(54), 'F');
  assert.equal(gradeFor(null), null);
});

test('fix plan ranks critical consent above medium seo and skips info', () => {
  const plan = buildFixPlan([
    { check: 'ai_search', findings: [{ id: 'a', title: 'Missing meta description', severity: 'medium', category: 'seo' }, { id: 'i', title: 'FYI', severity: 'info', category: 'seo' }] },
    { check: 'tracking_consent', findings: [{ id: 'b', title: 'GA4 fires before consent', severity: 'critical', category: 'consent', effort: 'low' }] },
    { check: 'speed_revenue', findings: [{ id: 'c', title: 'Slow LCP', severity: 'high', category: 'performance' }] },
  ]);
  assert.deepEqual(plan.map((p) => p.title), ['GA4 fires before consent', 'Slow LCP', 'Missing meta description']);
  assert.equal(plan[0]!.rank, 1);
  assert.ok(
    priorityScore({ id: 'x', title: 'x', severity: 'critical', category: 'consent', effort: 'low' }) >
      priorityScore({ id: 'y', title: 'y', severity: 'critical', category: 'seo', effort: 'high' }),
  );
});

test('overall score is a weighted mean that ignores missing scores', () => {
  assert.equal(overallScore([{ check: 'tracking_consent', score: 50 }, { check: 'ai_search', score: 100 }, { check: 'accessibility', score: null }]), 70);
  assert.equal(overallScore([{ check: 'x', score: null }]), null);
});
