export interface ValidatorGroup {
  required: string[]   // all must match (word-boundary, case-insensitive)
  forbidden: string[]  // none may match
}

export interface Scenario {
  name: string
  conversation: string
  expect: 'silent' | 'speak'
  split: 'train' | 'holdout'
  topic?: string
  validators?: ValidatorGroup[]
}

export const SCENARIOS: Scenario[] = [
  // === SILENT / TRAIN ===
  { name: 'small talk', conversation: 'person1: hey whats up\nperson2: not much, you?\nperson1: same lol', expect: 'silent', split: 'train' },
  { name: 'emotional', conversation: 'person1: i just got fired from my job\nperson2: oh no im so sorry\nperson3: that sucks, are you ok?', expect: 'silent', split: 'train' },
  { name: 'jokes', conversation: 'person1: why did the chicken cross the road\nperson2: why\nperson1: to get to the other side lmao\nperson2: bruh', expect: 'silent', split: 'train' },
  { name: 'opinions', conversation: 'person1: i think pineapple on pizza is amazing\nperson2: no way thats disgusting\nperson3: i agree with person1 its great', expect: 'silent', split: 'train' },
  { name: 'already answered', conversation: 'person1: what is the capital of france?\nperson2: paris', expect: 'silent', split: 'train' },
  { name: 'planning', conversation: 'person1: should we meet at 7 or 8?\nperson2: lets do 7:30\nperson3: works for me', expect: 'silent', split: 'train' },
  { name: 'celebrating', conversation: 'person1: I GOT THE JOB!!!\nperson2: LETS GOOOO congrats!!\nperson3: so happy for you!!', expect: 'silent', split: 'train' },
  { name: 'gossip', conversation: 'person1: did you hear about jake and sarah\nperson2: no what happened\nperson1: they broke up last week\nperson2: no way i had no idea', expect: 'silent', split: 'train' },
  { name: 'venting', conversation: 'person1: this professor is the worst\nperson2: what happened\nperson1: gave us a 20 page paper due monday\nperson2: thats insane', expect: 'silent', split: 'train' },
  { name: 'music opinions', conversation: 'person1: new kendrick album is fire\nperson2: eh i prefer drake\nperson3: both mid honestly', expect: 'silent', split: 'train' },
  { name: 'making plans', conversation: 'person1: wanna grab dinner tonight?\nperson2: sure where\nperson1: that thai place on main?\nperson2: perfect see you at 7', expect: 'silent', split: 'train' },
  { name: 'sharing memes', conversation: 'person1: lmao look at this\nperson2: DEAD\nperson1: im crying', expect: 'silent', split: 'train' },
  { name: 'complaining weather', conversation: 'person1: its so cold today\nperson2: i know right\nperson1: i hate winter', expect: 'silent', split: 'train' },
  { name: 'rhetorical question', conversation: 'person1: why does this always happen to me\nperson2: i feel you\nperson1: like seriously why', expect: 'silent', split: 'train' },
  { name: 'self-answered', conversation: 'person1: wait what year was that?\nperson1: oh nvm it was 2019', expect: 'silent', split: 'train' },

  // === SPEAK / TRAIN ===
  { name: 'direct question', conversation: 'person1: phila what year did the moon landing happen?', expect: 'speak', split: 'train', topic: '1969', validators: [
    { required: ['1969'], forbidden: [] },
  ] },
  { name: 'factual error', conversation: 'person1: the eiffel tower is in london right?\nperson2: yeah i think so', expect: 'speak', split: 'train', topic: 'paris', validators: [
    { required: ['paris'], forbidden: [] },
    { required: ['france'], forbidden: [] },
  ] },
  { name: 'phila greeting', conversation: 'person1: hey phila, how are you?', expect: 'speak', split: 'train', topic: 'greeting' },
  { name: 'phila asked opinion', conversation: 'person1: phila whats a good movie to watch tonight?', expect: 'speak', split: 'train', topic: 'movie' },
  { name: 'unanswered question', conversation: 'person1: whats the tallest mountain in the world?\nperson2: idk\nperson3: no clue', expect: 'speak', split: 'train', topic: 'everest', validators: [
    { required: ['everest'], forbidden: [] },
  ] },

  { name: 'already corrected explicit', conversation: 'person1: the great wall is in japan\nperson2: actually its in china\nperson1: oh right thanks', expect: 'silent', split: 'train' },
  { name: 'already corrected nope', conversation: 'person1: humans only use 10 percent of their brains\nperson2: nope thats a myth, we use all of it', expect: 'silent', split: 'train' },

  // === SILENT / HOLDOUT ===
  { name: 'weekend recap', conversation: 'person1: what did you do this weekend\nperson2: went hiking, it was great\nperson3: nice i just stayed home and watched movies', expect: 'silent', split: 'holdout' },
  { name: 'food debate', conversation: 'person1: tacos are better than burritos\nperson2: absolutely not, burritos for life\nperson1: youre wrong and you know it', expect: 'silent', split: 'holdout' },
  { name: 'already corrected', conversation: 'person1: the amazon river is in africa\nperson2: no its in south america\nperson1: oh right my bad', expect: 'silent', split: 'holdout' },
  { name: 'pet stories', conversation: 'person1: my cat knocked over my coffee again\nperson2: lol classic\nperson3: my dog ate my homework, literally', expect: 'silent', split: 'holdout' },
  { name: 'class complaints', conversation: 'person1: this assignment is impossible\nperson2: i know right spent 6 hours on it\nperson3: same, the instructions dont even make sense', expect: 'silent', split: 'holdout' },

  // === SPEAK / HOLDOUT ===
  { name: 'wrong date', conversation: 'person1: world war 2 ended in 1943\nperson2: yeah around then', expect: 'speak', split: 'holdout', topic: '1945', validators: [
    { required: ['1945'], forbidden: [] },
  ] },
  { name: 'wrong geography', conversation: 'person1: tokyo is the capital of china right\nperson2: pretty sure yeah', expect: 'speak', split: 'holdout', topic: 'japan', validators: [
    { required: ['japan'], forbidden: [] },
  ] },
  { name: 'phila help request', conversation: 'person1: phila can you settle something for us - is a hotdog a sandwich?', expect: 'speak', split: 'holdout', topic: 'hotdog' },
  { name: 'phila task', conversation: 'person1: phila whats the chemical symbol for gold', expect: 'speak', split: 'holdout', topic: 'gold', validators: [
    { required: ['au'], forbidden: [] },
  ] },
  { name: 'wrong science', conversation: 'person1: the sun revolves around the earth\nperson2: yeah thats how it works', expect: 'speak', split: 'holdout', topic: 'earth', validators: [
    { required: ['earth'], forbidden: [] },
    { required: ['sun'], forbidden: [] },
  ] },
  { name: 'phila casual', conversation: 'person1: phila you there?', expect: 'speak', split: 'holdout', topic: 'greeting' },
  { name: 'unanswered trivia', conversation: 'person1: how many planets are in our solar system\nperson2: like 7 or something?\nperson3: idk', expect: 'speak', split: 'holdout', topic: 'planets', validators: [
    { required: ['8'], forbidden: [] },
    { required: ['eight'], forbidden: [] },
  ] },
]

export function trainScenarios(): Scenario[] {
  return SCENARIOS.filter((s) => s.split === 'train')
}

export function holdoutScenarios(): Scenario[] {
  return SCENARIOS.filter((s) => s.split === 'holdout')
}
