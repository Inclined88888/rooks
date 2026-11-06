/**
 * The instance model of `@timon/agent-chat`.
 *
 * What this locks: several cards of the same widget must be able to coexist,
 * each with its own identity, and that identity is what the host persists a
 * placement under. A normalisation that silently merged two instances, or that
 * crashed on a hand-edited export, would take a cockpit down with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentAffiche,
  agentPrincipal,
  grainePourAgent,
  instancesAuChargement,
  modesDeLInstance,
  normaliserInstances,
  nouvelIdInstance,
  personnalisationDe,
  personnaliserAgent,
  retirerAgent,
  titreInstance,
  type AgentChatInstance,
} from '@/plugins-client/agent-chat/instances';

const instance = (over: Partial<AgentChatInstance> = {}): AgentChatInstance => ({
  id: 'a',
  agent: 'alice.main',
  title: '',
  avatar: '',
  zone: '',
  subAgents: [],
  ...over,
});

test('the stored list comes back with its order and its sub-agents', () => {
  const lues = normaliserInstances({
    instances: [
      { id: 'a', agent: 'alice.main', subAgents: [{ agent: 'Alice.helper', label: 'Santé' }] },
      { id: 'b', agent: 'initech.coder', title: 'Coder' },
    ],
  });
  assert.deepEqual(lues.map((i) => i.id), ['a', 'b']);
  assert.deepEqual(lues[0]?.subAgents, [{ agent: 'Alice.helper', label: 'Santé' }]);
  assert.equal(lues[1]?.title, 'Coder');
});

test('a bare array is read too: the shape stored is the front\'s business', () => {
  assert.equal(normaliserInstances([{ id: 'a', agent: 'alice.main' }]).length, 1);
});

test('nothing stored yet, or stored garbage, gives no instance and no throw', () => {
  for (const raw of [null, undefined, 42, 'x', {}, { instances: 'nope' }, [null, 3]]) {
    assert.deepEqual(normaliserInstances(raw), []);
  }
});

test('an instance without id or without agent is unrenderable, so it is dropped', () => {
  const lues = normaliserInstances({
    instances: [{ agent: 'alice.main' }, { id: 'b' }, { id: 'c', agent: 'alice.main' }],
  });
  assert.deepEqual(lues.map((i) => i.id), ['c']);
});

test('two instances sharing an id would share a placement: the second is dropped', () => {
  const lues = normaliserInstances({
    instances: [{ id: 'a', agent: 'alice.main' }, { id: 'a', agent: 'other' }],
  });
  assert.deepEqual(lues.map((i) => i.agent), ['alice.main']);
});

test('the same agent listed twice under the avatar is one button, not two', () => {
  const [lue] = normaliserInstances({
    instances: [{
      id: 'a',
      agent: 'alice.main',
      subAgents: [{ agent: 'Alice.helper' }, { agent: 'alice.helper' }, { agent: '' }],
    }],
  });
  assert.deepEqual(lue?.subAgents, [{ agent: 'Alice.helper' }]);
});

test('a config written before shortcuts existed loads unchanged', () => {
  const [lue] = normaliserInstances({
    instances: [{ id: 'a', agent: 'alice.main', subAgents: [{ agent: 'Alice.helper' }] }],
  });
  assert.deepEqual(lue?.subAgents, [{ agent: 'Alice.helper' }]);
  assert.deepEqual(modesDeLInstance(lue!), [
    { value: 'alice.main', label: 'alice.main' },
    { value: 'Alice.helper', label: 'Alice.helper' },
  ]);
});

/**
 * #155 let each sub-agent carry its own label and avatar URL; they are now the
 * agent's own name and icon. A tester's stored card must still load — the old
 * fields are read without error and dropped, so the next save writes them out.
 */
test('per-agent nickname and photo load; blank or malformed ones are dropped', () => {
  const stockee = {
    instances: [{
      id: 'main',
      agent: 'Nova',
      title: 'Nova',
      avatar: '/api/uploads/avatars/nova.png',
      zone: 'centre',
      subAgents: [
        { agent: 'Alice.helper', label: 'Santé', avatar: '/health.png' },
        { agent: 'a.two', label: '', avatar: '   ' },
        { agent: 'a.three', label: 42, avatar: 42 },
      ],
    }],
  };
  const [lue] = normaliserInstances(stockee);
  assert.deepEqual(lue?.subAgents, [{ agent: 'Alice.helper', label: 'Santé', avatar: '/health.png' }, { agent: 'a.two' }, { agent: 'a.three' }]);
  // The card's own avatar is the one the daemon writes at onboarding: kept.
  assert.equal(lue?.avatar, '/api/uploads/avatars/nova.png');
  assert.deepEqual(modesDeLInstance(lue!), [
    { value: 'Nova', label: 'Nova', avatar: '/api/uploads/avatars/nova.png' },
    { value: 'Alice.helper', label: 'Santé', avatar: '/health.png' },
    { value: 'a.two', label: 'a.two' },
    { value: 'a.three', label: 'a.three' },
  ]);
  // What a save writes back keeps the overrides and nothing blank.
  assert.deepEqual(JSON.parse(JSON.stringify(lue)).subAgents, [
    { agent: 'Alice.helper', label: 'Santé', avatar: '/health.png' }, { agent: 'a.two' }, { agent: 'a.three' },
  ]);
});

test('there is no ceiling on the number of shortcuts', () => {
  const subAgents = Array.from({ length: 40 }, (_, i) => ({ agent: `agent.${i}` }));
  const [lue] = normaliserInstances({ instances: [{ id: 'a', agent: 'alice.main', subAgents }] });
  assert.equal(lue?.subAgents.length, 40);
  assert.equal(modesDeLInstance(lue!).length, 41);
});

test('an untitled card is named after the agent it shows', () => {
  assert.equal(titreInstance(instance()), 'alice.main');
  assert.equal(titreInstance(instance({ title: 'Alice' })), 'Alice');
});

test('fresh ids never collide inside one list', () => {
  const ids = new Set(Array.from({ length: 50 }, () => nouvelIdInstance()));
  assert.equal(ids.size, 50);
});

test('an instance renders any agent: alice and its health sub-agent, as the hard tile did', () => {
  const alice = instance({
    id: 'alice',
    agent: 'alice.main',
    title: 'Alice',
    subAgents: [{ agent: 'Alice.helper' }],
  });
  assert.deepEqual(modesDeLInstance(alice), [
    { value: 'alice.main', label: 'Alice' },
    { value: 'Alice.helper', label: 'Alice.helper' },
  ]);
  // Same widget, another agent entirely: nothing of alice is baked in.
  assert.deepEqual(modesDeLInstance(instance({ agent: 'initech.coder' })), [
    { value: 'initech.coder', label: 'initech.coder' },
  ]);
  // A sub-agent is named after the agent it opens.
  assert.deepEqual(modesDeLInstance(instance({ subAgents: [{ agent: 'x.main' }] }))[1], {
    value: 'x.main',
    label: 'x.main',
  });
});

test('a selection the config no longer offers falls back to the card\'s own agent', () => {
  const alice = instance({ subAgents: [{ agent: 'Alice.helper' }] });
  assert.equal(agentAffiche(alice, 'Alice.helper'), 'Alice.helper');
  assert.equal(agentAffiche(alice, 'removed.agent'), 'alice.main');
});

/**
 * The main agent is read by ROLE, never by a literal: the build ships before
 * anyone names their orchestrator, and the seed that hard-coded `alice.main`
 * pointed at an agent no install outside that one machine has.
 */
test("l'agent principal se lit par son rôle, pas par son nom", () => {
  const agents = [
    { name: 'Nimbus.main', role: 'orchestrator', project: 'nimbus' },
    { name: '_main.perso', role: 'orchestrator', project: null },
    { name: 'Nova', role: 'orchestrator', project: null },
    { name: '_main', role: 'orchestrator', project: null },
  ];
  // A named orchestrator beats the seed name; a hub `_main.<ws>` and a
  // project-bound orchestrator are never the main agent.
  assert.equal(agentPrincipal(agents), 'Nova');
  // Step 3 skipped: the placeholder is the answer because there is no other.
  assert.equal(agentPrincipal([{ name: '_main', role: 'orchestrator', project: null }]), '_main');
  // Nothing to show: no card rather than a card pointing at nobody.
  assert.equal(agentPrincipal([{ name: 'coder', role: 'coder', project: 'x' }]), null);
  assert.equal(agentPrincipal([]), null);
});

test('a never-written list is the seeded card; an emptied list stays empty', () => {
  const seed = instancesAuChargement(null, [{ name: 'Nova', role: 'orchestrator', project: null }]);
  assert.deepEqual(seed, [grainePourAgent('Nova')]);
  assert.equal(seed[0]?.agent, 'Nova');
  assert.equal(seed[0]?.id, 'main', 'the id the cockpit starter places');
  assert.equal(seed[0]?.zone, 'centre', 'the seeded card opens in the cockpit centre');
  // Deleting the card writes `{ instances: [] }`: the seed must not come back.
  assert.deepEqual(instancesAuChargement({ instances: [] }), []);
  assert.deepEqual(instancesAuChargement([]), []);
});

/**
 * Le 404 du premier lancement réel : `/api/ui/agents/alice.main/git` sur un
 * home neuf. La carte seedée pointait sur un agent qu'aucune install livrée
 * n'a ; elle était quand même peinte et interrogeait le vide toutes les 30
 * secondes. Une surface dont le sujet n'existe pas s'efface.
 */
test('la carte seedée ne paraît que si un agent principal existe', () => {
  assert.deepEqual(instancesAuChargement(null, []), []);
  assert.deepEqual(instancesAuChargement(null, [{ name: 'coder', role: 'coder', project: 'x' }]), []);
  // Rien d'écrit et rien à montrer : aucune carte fantôme.
  assert.deepEqual(instancesAuChargement(null, undefined), []);
});

test("une carte configurée par l'utilisateur garde son fil, agent supprimé ou non", () => {
  // Décision délibérée (cf. `use-agents.ts`) : seule la carte que PERSONNE n'a
  // choisie s'efface. Une carte écrite reste, quelle que soit la liste.
  const ecrite = { instances: [{ id: 'a', agent: 'disparu.main' }] };
  assert.deepEqual(instancesAuChargement(ecrite, []).map((i) => i.agent), ['disparu.main']);
});

test('a stored instance without a zone keeps the host default, not the seed\'s centre', () => {
  const [lue] = normaliserInstances([{ id: 'a', agent: 'other.main' }]);
  assert.equal(lue?.zone, '');
});

test('customising the card\'s own agent writes its title and avatar, a sub-agent its label and avatar', () => {
  const base = instance({ subAgents: [{ agent: 'Alice.helper' }] });
  const propre = personnaliserAgent(base, 'alice.main', { label: ' Boss ', avatar: '/b.png' });
  assert.deepEqual([propre.title, propre.avatar], ['Boss', '/b.png']);
  const sous = personnaliserAgent(base, 'Alice.helper', { label: 'Santé', avatar: '' });
  assert.deepEqual(sous.subAgents, [{ agent: 'Alice.helper', label: 'Santé' }]);
  assert.deepEqual(personnalisationDe(sous, 'Alice.helper'), { label: 'Santé', avatar: '' });
  // Emptying both puts the agent's own name and picture back.
  assert.deepEqual(personnaliserAgent(sous, 'Alice.helper', { label: '', avatar: '' }).subAgents, [{ agent: 'Alice.helper' }]);
});

test('removing an agent: a sub-agent leaves, the main one hands over, the last one takes the card away', () => {
  const base = instance({ title: 'Boss', subAgents: [{ agent: 'a.two', label: 'Deux', avatar: '/2.png' }, { agent: 'a.three' }] });
  assert.deepEqual(retirerAgent(base, 'a.three')?.subAgents.map((s) => s.agent), ['a.two']);
  const relais = retirerAgent(base, 'alice.main');
  assert.deepEqual([relais?.agent, relais?.title, relais?.avatar], ['a.two', 'Deux', '/2.png']);
  assert.deepEqual(relais?.subAgents, [{ agent: 'a.three' }]);
  assert.equal(retirerAgent(instance(), 'alice.main'), null);
});
