// Generalized version of lib/research/jevDedup.js's Jev Choice pattern -
// same vendor (TypeSafe's System One API), same typed-Choice-over-criteria
// shape, applied to "is this external post relevant to a topic list" rather
// than "does this candidate duplicate an existing Opportunity." Deliberately
// its own file rather than extending jevDedup.js: a change to one judgment's
// criteria/fail-mode should never silently change the other's.

const JEV_API_URL = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const MAX_CRITERIA = 200;

export function jevAvailable() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

async function callJev({ state, questions, fetchImpl = fetch }) {
  const response = await fetchImpl(JEV_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ state, model: JEV_MODEL, questions })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jev request failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

function buildTopicCriteria(topics) {
  const criteria = {
    none: 'This post is not meaningfully about any topic listed below - it is off-topic, generic, spam, or promotional noise.'
  };
  topics.slice(0, MAX_CRITERIA).forEach((topic, index) => {
    const key = typeof topic === 'string' ? `topic_${index}` : topic.key ?? `topic_${index}`;
    const description = typeof topic === 'string' ? topic : topic.description ?? topic.key;
    criteria[key] = description;
  });
  return criteria;
}

// Fails CLOSED (relevant:false) on any problem - no key, no topics
// configured, a network error, a malformed response. Unlike
// checkOpportunityDuplicate (whose false-negative risk is "an Opportunity
// sits in the backlog a bit longer," harmless), this gates an autonomous
// PUBLIC post: guessing "relevant" when the classifier couldn't actually
// run risks posting something off-topic or spammy-looking under a real
// account. The safe failure direction here is "skip this post," not
// "assume it's fine."
export async function checkPostRelevance({ text, topics, fetchImpl = fetch } = {}) {
  if (!jevAvailable()) {
    return { checked: false, relevant: false, reason: 'TYPESAFE_API_KEY not set' };
  }
  if (!Array.isArray(topics) || topics.length === 0) {
    return { checked: false, relevant: false, reason: 'no topics configured' };
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return { checked: false, relevant: false, reason: 'no post text to classify' };
  }

  const state = { post_text: text };
  const questions = {
    topic_match: {
      type: 'choice',
      instructions:
        'The state is the text of a public social media post. Which topic below, if any, is this post genuinely and substantively about? Pick "none" if the post is off-topic, too generic, spam, or purely promotional noise unrelated to any topic.',
      criteria: buildTopicCriteria(topics)
    }
  };

  try {
    const response = await callJev({ state, questions, fetchImpl });
    const match = response?.answers?.topic_match?.choice ?? 'none';
    if (!match || match === 'none') {
      return { checked: true, relevant: false };
    }
    const confidence = response?.answers?.topic_match?.confidence ?? 'unknown';
    return { checked: true, relevant: true, matchedTopic: match, confidence };
  } catch (error) {
    return { checked: false, relevant: false, reason: `Jev call failed: ${error.message}` };
  }
}
