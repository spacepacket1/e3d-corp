#!/usr/bin/env node
// One-time (or on-demand) backlog triage aid: clusters the untriaged
// ("scored", never decided reviewed/pursuing/no-value) Opportunity backlog
// by semantic duplication, using the same Jev check that now runs on fresh
// discovery candidates (lib/research/jevDedup.js, lib/opportunities/engine.js).
//
// Read-only - this NEVER changes an opportunity's status or writes any
// event. Unlike skipping a duplicate before it's even created (cheap to be
// wrong about), retroactively marking an *existing* opportunity no-value is
// a real decision this script has no business making silently on 272
// records. It only regroups what already exists so a human can triage the
// distinct findings instead of the raw pile.
//
// Clusters newest-first, so each cluster's representative is the most
// recent occurrence of a recurring finding, not an arbitrary old one.

import { loadInstance } from '../../lib/config.js';
import { listOpportunities } from '../../lib/opportunities/store.js';
import { checkOpportunityDuplicate, jevAvailable } from '../../lib/research/jevDedup.js';

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : 'unknown';
}

async function clusterOpportunities(opportunities) {
  const clusters = [];

  for (const opportunity of opportunities) {
    const representatives = clusters.map((cluster) => cluster.representative);
    const dedup = await checkOpportunityDuplicate({
      candidateTitle: opportunity.title,
      candidateDescription: opportunity.description,
      existingOpportunities: representatives
    });

    if (dedup.isDuplicate) {
      const cluster = clusters.find((candidate) => candidate.representative.id === dedup.matchedOpportunityId);
      if (cluster) {
        cluster.members.push({ opportunity, confidence: dedup.confidence });
        continue;
      }
    }

    clusters.push({ representative: opportunity, members: [] });
  }

  return clusters;
}

function printReport(clusters, total) {
  const distinctCount = clusters.length;
  const duplicateCount = total - distinctCount;

  console.log(`Backlog triage report: ${total} untriaged opportunities -> ${distinctCount} distinct findings (${duplicateCount} duplicates folded in)\n`);

  const sorted = [...clusters].sort((a, b) => (b.representative.score?.value ?? 0) - (a.representative.score?.value ?? 0));

  for (const cluster of sorted) {
    const rep = cluster.representative;
    const score = rep.score?.value !== undefined ? rep.score.value.toFixed(2) : '?.??';
    console.log(`[${score}] ${rep.title}  (id ${shortId(rep.id)}, ${rep.createdAt?.slice(0, 10)}, type=${rep.type})`);
    if (cluster.members.length > 0) {
      console.log(`  + ${cluster.members.length} duplicate(s) folded in:`);
      for (const member of cluster.members) {
        console.log(
          `    - ${member.opportunity.title} (id ${shortId(member.opportunity.id)}, ${member.opportunity.createdAt?.slice(0, 10)}, confidence=${member.confidence})`
        );
      }
    }
    console.log('');
  }
}

async function main() {
  const instanceName = process.argv.includes('--instance')
    ? process.argv[process.argv.indexOf('--instance') + 1]
    : 'futco';

  if (!jevAvailable()) {
    throw new Error('TYPESAFE_API_KEY is not set - nothing to cluster with');
  }

  const { dataDir } = loadInstance(instanceName);
  const backlog = listOpportunities(dataDir, { status: 'scored' }).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  if (backlog.length === 0) {
    console.log('No untriaged ("scored") opportunities.');
    return;
  }

  const clusters = await clusterOpportunities(backlog);
  printReport(clusters, backlog.length);
}

main().catch((error) => {
  process.stderr.write(`Backlog report failed: ${error.message}\n`);
  process.exitCode = 1;
});
