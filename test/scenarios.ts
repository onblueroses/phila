export interface ValidatorGroup {
  required: string[]   // all must match (word-boundary, case-insensitive)
  forbidden: string[]  // none may match
}

export type ScenarioCategory =
  | 'silent-social'      // small talk, emotions, opinions, celebrations
  | 'silent-corrected'   // someone already corrected the error
  | 'silent-rhetorical'  // rhetorical questions, venting
  | 'silent-logistics'   // planning, coordination
  | 'silent-media'       // memes, links, reactions
  | 'speak-direct'       // phila addressed by name
  | 'speak-correction'   // factual error needing correction
  | 'speak-unanswered'   // factual question nobody answered
  | 'adversarial'        // edge cases designed to trick the model

export type Difficulty = 'easy' | 'medium' | 'hard' | 'adversarial'

export interface Scenario {
  name: string
  conversation: string
  expect: 'silent' | 'speak'
  split: 'train' | 'holdout'
  category: ScenarioCategory
  difficulty: Difficulty
  topic?: string
  validators?: ValidatorGroup[]
}

export const SCENARIOS: Scenario[] = [
  // ============================================================
  // SILENT / TRAIN
  // ============================================================

  // -- silent-social (easy) --
  { name: 'small talk', conversation: 'person1: hey whats up\nperson2: not much, you?\nperson1: same lol', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },
  { name: 'emotional', conversation: 'person1: i just got fired from my job\nperson2: oh no im so sorry\nperson3: that sucks, are you ok?', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },
  { name: 'jokes', conversation: 'person1: why did the chicken cross the road\nperson2: why\nperson1: to get to the other side lmao\nperson2: bruh', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },
  { name: 'opinions', conversation: 'person1: i think pineapple on pizza is amazing\nperson2: no way thats disgusting\nperson3: i agree with person1 its great', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },
  { name: 'celebrating', conversation: 'person1: I GOT THE JOB!!!\nperson2: LETS GOOOO congrats!!\nperson3: so happy for you!!', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },
  { name: 'gossip', conversation: 'person1: did you hear about jake and sarah\nperson2: no what happened\nperson1: they broke up last week\nperson2: no way i had no idea', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },
  { name: 'venting', conversation: 'person1: this professor is the worst\nperson2: what happened\nperson1: gave us a 20 page paper due monday\nperson2: thats insane', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },
  { name: 'music opinions', conversation: 'person1: new kendrick album is fire\nperson2: eh i prefer drake\nperson3: both mid honestly', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },
  { name: 'complaining weather', conversation: 'person1: its so cold today\nperson2: i know right\nperson1: i hate winter', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'easy' },

  // -- silent-social (medium) --
  { name: 'emoji only conversation', conversation: 'person1: 😂😂😂\nperson2: 💀💀\nperson3: im dead', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'medium' },
  { name: 'inside joke', conversation: 'person1: remember the spoon thing\nperson2: LMAOOO dont even\nperson1: i still cant believe that happened\nperson2: iconic moment honestly', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'medium' },
  { name: 'sarcastic agreement', conversation: 'person1: mondays are the best day of the week\nperson2: oh yeah absolutely love waking up at 6am\nperson1: nothing better than a full inbox', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'medium' },
  { name: 'relationship advice', conversation: 'person1: should i text him back\nperson2: absolutely not\nperson3: girl no\nperson1: ok fine', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'medium' },
  { name: 'workout chat', conversation: 'person1: hit a new PR today 225 bench\nperson2: lets go bro\nperson3: beast mode', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'medium' },
  { name: 'tv show spoilers', conversation: 'person1: NO SPOILERS but that ending\nperson2: i know right\nperson1: i literally screamed\nperson3: same same same', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'medium' },
  { name: 'gaming', conversation: 'person1: anyone wanna play tonight\nperson2: im down\nperson3: what time\nperson1: like 9?\nperson2: bet', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'medium' },
  { name: 'complimenting friend', conversation: 'person1: just saw your new profile pic you look amazing\nperson2: omg stop thank you\nperson3: seriously gorgeous', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'medium' },

  // -- silent-social (hard) --
  { name: 'debating with false claim as joke', conversation: 'person1: the earth is obviously flat lol\nperson2: yeah and birds arent real 😂\nperson1: finally someone gets it\nperson3: wake up sheeple lmao', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'hard' },
  { name: 'long rambling thread', conversation: 'person1: ok so basically what happened was\nperson1: i went to the store right\nperson1: and then i saw this guy\nperson1: and he was wearing the exact same shirt as me\nperson2: lol no way\nperson1: i swear\nperson3: twins', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'hard' },
  { name: 'opinion that sounds like question', conversation: 'person1: isnt it weird how we just accept that\nperson2: yeah society is strange\nperson3: literally never thought about it', expect: 'silent', split: 'train', category: 'silent-social', difficulty: 'hard' },

  // -- silent-logistics --
  { name: 'already answered', conversation: 'person1: what is the capital of france?\nperson2: paris', expect: 'silent', split: 'train', category: 'silent-logistics', difficulty: 'easy' },
  { name: 'planning', conversation: 'person1: should we meet at 7 or 8?\nperson2: lets do 7:30\nperson3: works for me', expect: 'silent', split: 'train', category: 'silent-logistics', difficulty: 'easy' },
  { name: 'making plans', conversation: 'person1: wanna grab dinner tonight?\nperson2: sure where\nperson1: that thai place on main?\nperson2: perfect see you at 7', expect: 'silent', split: 'train', category: 'silent-logistics', difficulty: 'easy' },
  { name: 'coordinating rides', conversation: 'person1: who is driving tomorrow\nperson2: i can but need gas money\nperson3: ill venmo you\nperson1: cool im in', expect: 'silent', split: 'train', category: 'silent-logistics', difficulty: 'medium' },
  { name: 'splitting a bill', conversation: 'person1: dinner was 90 so 30 each\nperson2: sending now\nperson3: same', expect: 'silent', split: 'train', category: 'silent-logistics', difficulty: 'medium' },

  // -- silent-media --
  { name: 'sharing memes', conversation: 'person1: lmao look at this\nperson2: DEAD\nperson1: im crying', expect: 'silent', split: 'train', category: 'silent-media', difficulty: 'easy' },
  { name: 'link sharing', conversation: 'person1: you guys seen this? https://example.com/article\nperson2: yeah thats wild\nperson3: bookmarked', expect: 'silent', split: 'train', category: 'silent-media', difficulty: 'medium' },
  { name: 'photo reactions', conversation: 'person1: check out sunset from my hike\nperson2: wow thats stunning\nperson3: jealous af\nperson1: it was so peaceful up there', expect: 'silent', split: 'train', category: 'silent-media', difficulty: 'medium' },

  // -- silent-rhetorical --
  { name: 'rhetorical question', conversation: 'person1: why does this always happen to me\nperson2: i feel you\nperson1: like seriously why', expect: 'silent', split: 'train', category: 'silent-rhetorical', difficulty: 'easy' },
  { name: 'self-answered', conversation: 'person1: wait what year was that?\nperson1: oh nvm it was 2019', expect: 'silent', split: 'train', category: 'silent-rhetorical', difficulty: 'easy' },
  { name: 'exasperated why', conversation: 'person1: why do i even bother studying\nperson2: mood\nperson3: because you want to pass?? lol', expect: 'silent', split: 'train', category: 'silent-rhetorical', difficulty: 'medium' },
  { name: 'hypothetical question', conversation: 'person1: what would you do with a million dollars\nperson2: quit my job immediately\nperson3: travel the world\nperson1: same honestly', expect: 'silent', split: 'train', category: 'silent-rhetorical', difficulty: 'medium' },

  // -- silent-corrected --
  { name: 'already corrected explicit', conversation: 'person1: the great wall is in japan\nperson2: actually its in china\nperson1: oh right thanks', expect: 'silent', split: 'train', category: 'silent-corrected', difficulty: 'medium' },
  { name: 'already corrected nope', conversation: 'person1: humans only use 10 percent of their brains\nperson2: nope thats a myth, we use all of it', expect: 'silent', split: 'train', category: 'silent-corrected', difficulty: 'medium' },
  { name: 'already corrected with gap', conversation: 'person1: lightning never strikes the same place twice\nperson2: lol thats crazy\nperson3: thats actually a myth it totally does', expect: 'silent', split: 'train', category: 'silent-corrected', difficulty: 'hard' },
  { name: 'already corrected partial', conversation: 'person1: einstein failed math in school\nperson2: pretty sure thats not true\nperson1: really? i always heard that', expect: 'silent', split: 'train', category: 'silent-corrected', difficulty: 'hard' },
  { name: 'already corrected polite', conversation: 'person1: vitamin c cures the common cold\nperson2: i think thats been debunked actually, it might help a little but doesnt cure it', expect: 'silent', split: 'train', category: 'silent-corrected', difficulty: 'hard' },

  // ============================================================
  // SPEAK / TRAIN
  // ============================================================

  // -- speak-direct (easy) --
  { name: 'direct question', conversation: 'person1: phila what year did the moon landing happen?', expect: 'speak', split: 'train', category: 'speak-direct', difficulty: 'easy', topic: '1969', validators: [
    { required: ['1969'], forbidden: [] },
  ] },
  { name: 'phila greeting', conversation: 'person1: hey phila, how are you?', expect: 'speak', split: 'train', category: 'speak-direct', difficulty: 'easy', topic: 'greeting' },
  { name: 'phila asked opinion', conversation: 'person1: phila whats a good movie to watch tonight?', expect: 'speak', split: 'train', category: 'speak-direct', difficulty: 'easy', topic: 'movie' },

  // -- speak-direct (medium) --
  { name: 'phila mid-sentence', conversation: 'person1: i was thinking phila might know the answer\nperson2: yeah ask phila', expect: 'speak', split: 'train', category: 'speak-direct', difficulty: 'medium', topic: 'acknowledgment' },
  { name: 'phila lowercase in question', conversation: 'person1: yo phila do you know what time the game starts', expect: 'speak', split: 'train', category: 'speak-direct', difficulty: 'medium', topic: 'game' },
  { name: 'phila with emoji', conversation: 'person1: phila whats the weather gonna be like tomorrow 🌧️', expect: 'speak', split: 'train', category: 'speak-direct', difficulty: 'medium', topic: 'weather' },
  { name: 'phila multi-question', conversation: 'person1: phila two questions - whats the speed of light and whos the current president of france', expect: 'speak', split: 'train', category: 'speak-direct', difficulty: 'medium', topic: 'knowledge' },

  // -- speak-correction (easy) --
  { name: 'factual error', conversation: 'person1: the eiffel tower is in london right?\nperson2: yeah i think so', expect: 'speak', split: 'train', category: 'speak-correction', difficulty: 'easy', topic: 'paris', validators: [
    { required: ['paris'], forbidden: [] },
    { required: ['france'], forbidden: [] },
  ] },

  // -- speak-correction (medium) --
  { name: 'wrong math', conversation: 'person1: a triangle has 4 sides\nperson2: yeah sounds right', expect: 'speak', split: 'train', category: 'speak-correction', difficulty: 'medium', topic: 'three', validators: [
    { required: ['3'], forbidden: [] },
    { required: ['three'], forbidden: [] },
  ] },
  { name: 'wrong animal fact', conversation: 'person1: dolphins are fish right\nperson2: yeah they live in the ocean so they must be', expect: 'speak', split: 'train', category: 'speak-correction', difficulty: 'medium', topic: 'mammal', validators: [
    { required: ['mammal'], forbidden: [] },
  ] },

  // -- speak-correction (hard) --
  { name: 'subtle wrong year', conversation: 'person1: the berlin wall fell in 1991\nperson2: yeah around there\nperson3: crazy how long ago that was', expect: 'speak', split: 'train', category: 'speak-correction', difficulty: 'hard', topic: '1989', validators: [
    { required: ['1989'], forbidden: [] },
  ] },
  { name: 'wrong attribution', conversation: 'person1: "be the change you wish to see" - thats MLK right?\nperson2: i think so yeah', expect: 'speak', split: 'train', category: 'speak-correction', difficulty: 'hard', topic: 'gandhi', validators: [
    { required: ['gandhi'], forbidden: [] },
  ] },

  // -- speak-unanswered (easy) --
  { name: 'unanswered question', conversation: 'person1: whats the tallest mountain in the world?\nperson2: idk\nperson3: no clue', expect: 'speak', split: 'train', category: 'speak-unanswered', difficulty: 'easy', topic: 'everest', validators: [
    { required: ['everest'], forbidden: [] },
  ] },

  // -- speak-unanswered (medium) --
  { name: 'unanswered buried in thread', conversation: 'person1: great party last night\nperson2: yeah it was fun\nperson1: btw does anyone know what the boiling point of water is in fahrenheit\nperson2: no idea\nperson3: the music was so good though', expect: 'speak', split: 'train', category: 'speak-unanswered', difficulty: 'hard', topic: '212', validators: [
    { required: ['212'], forbidden: [] },
  ] },
  { name: 'unanswered with wrong guess', conversation: 'person1: how many bones does a human body have\nperson2: like 150?\nperson3: idk something like that', expect: 'speak', split: 'train', category: 'speak-unanswered', difficulty: 'medium', topic: '206', validators: [
    { required: ['206'], forbidden: [] },
  ] },

  // ============================================================
  // SILENT / HOLDOUT
  // ============================================================

  // -- silent-social --
  { name: 'weekend recap', conversation: 'person1: what did you do this weekend\nperson2: went hiking, it was great\nperson3: nice i just stayed home and watched movies', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'easy' },
  { name: 'food debate', conversation: 'person1: tacos are better than burritos\nperson2: absolutely not, burritos for life\nperson1: youre wrong and you know it', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'easy' },
  { name: 'pet stories', conversation: 'person1: my cat knocked over my coffee again\nperson2: lol classic\nperson3: my dog ate my homework, literally', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'easy' },
  { name: 'class complaints', conversation: 'person1: this assignment is impossible\nperson2: i know right spent 6 hours on it\nperson3: same, the instructions dont even make sense', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'easy' },
  { name: 'vacation stories', conversation: 'person1: just got back from mexico\nperson2: how was it\nperson1: incredible, the food was amazing\nperson3: so jealous', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'easy' },
  { name: 'morning greetings', conversation: 'person1: good morning everyone\nperson2: morning!\nperson3: hey hey\nperson1: hope everyone slept well', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'easy' },
  { name: 'goodnight', conversation: 'person1: alright im heading to bed\nperson2: night!\nperson3: sleep well\nperson1: you too', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'easy' },

  // -- silent-social (medium holdout) --
  { name: 'debate with strong opinions', conversation: 'person1: android is objectively better than iphone\nperson2: oh here we go again\nperson3: can we not do this\nperson1: im just saying\nperson2: and youre wrong', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'medium' },
  { name: 'nostalgia', conversation: 'person1: remember when we used to hang out at that park\nperson2: omg yes that was the best\nperson3: i miss those days\nperson1: we should go back sometime', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'medium' },
  { name: 'birthday wishes', conversation: 'person1: HAPPY BIRTHDAY PERSON2!!!\nperson3: happy bday!!! 🎂\nperson2: thanks you guys!! love you', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'medium' },
  { name: 'work rant', conversation: 'person1: my boss just scheduled a meeting at 4:55 on friday\nperson2: thats criminal\nperson3: quit\nperson1: honestly considering it', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'medium' },
  { name: 'cooking disaster', conversation: 'person1: tried making pasta from scratch\nperson2: how did it go\nperson1: the kitchen looks like a warzone\nperson3: lmaooo\nperson2: pics or it didnt happen', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'medium' },

  // -- silent-social (hard holdout) --
  { name: 'joke that sounds like wrong fact', conversation: 'person1: birds arent real\nperson2: the government replaced them all with drones\nperson3: wake up people\nperson1: finally someone understands', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'hard' },
  { name: 'exaggeration as humor', conversation: 'person1: this coffee has literally saved my life 47 times today\nperson2: only 47? amateur\nperson3: im on my third pot', expect: 'silent', split: 'holdout', category: 'silent-social', difficulty: 'hard' },

  // -- silent-corrected (holdout) --
  { name: 'already corrected', conversation: 'person1: the amazon river is in africa\nperson2: no its in south america\nperson1: oh right my bad', expect: 'silent', split: 'holdout', category: 'silent-corrected', difficulty: 'medium' },
  { name: 'already corrected with link', conversation: 'person1: napoleon was super short like 5 feet\nperson2: actually he was average height for the time, about 5 foot 7\nperson1: oh really? huh', expect: 'silent', split: 'holdout', category: 'silent-corrected', difficulty: 'medium' },
  { name: 'already corrected multi-person', conversation: 'person1: goldfish have a 3 second memory\nperson2: thats actually a myth\nperson3: yeah ive heard they can remember stuff for months\nperson1: no way seriously?', expect: 'silent', split: 'holdout', category: 'silent-corrected', difficulty: 'hard' },

  // -- silent-logistics (holdout) --
  { name: 'grocery list', conversation: 'person1: who is getting what for the bbq\nperson2: ill bring chips and salsa\nperson3: ill get the drinks\nperson1: cool ill handle the meat', expect: 'silent', split: 'holdout', category: 'silent-logistics', difficulty: 'easy' },
  { name: 'homework coordination', conversation: 'person1: did anyone do problem 5\nperson2: yeah its integration by parts\nperson1: oh ok i see it now thanks\nperson3: same i got stuck there too', expect: 'silent', split: 'holdout', category: 'silent-logistics', difficulty: 'medium' },

  // -- silent-rhetorical (holdout) --
  { name: 'existential musing', conversation: 'person1: do you ever wonder what the point of all this is\nperson2: bro its 2am go to sleep\nperson3: deep thoughts at midnight', expect: 'silent', split: 'holdout', category: 'silent-rhetorical', difficulty: 'medium' },
  { name: 'hypothetical would you rather', conversation: 'person1: would you rather fight 100 duck-sized horses or one horse-sized duck\nperson2: duck-sized horses easy\nperson3: youre crazy the duck would be terrifying\nperson1: exactly', expect: 'silent', split: 'holdout', category: 'silent-rhetorical', difficulty: 'medium' },

  // -- silent-media (holdout) --
  { name: 'song lyrics chain', conversation: 'person1: is this the real life\nperson2: is this just fantasy\nperson3: caught in a landslide\nperson1: no escape from reality', expect: 'silent', split: 'holdout', category: 'silent-media', difficulty: 'medium' },

  // ============================================================
  // SPEAK / HOLDOUT
  // ============================================================

  // -- speak-correction --
  { name: 'wrong date', conversation: 'person1: world war 2 ended in 1943\nperson2: yeah around then', expect: 'speak', split: 'holdout', category: 'speak-correction', difficulty: 'easy', topic: '1945', validators: [
    { required: ['1945'], forbidden: [] },
  ] },
  { name: 'wrong geography', conversation: 'person1: tokyo is the capital of china right\nperson2: pretty sure yeah', expect: 'speak', split: 'holdout', category: 'speak-correction', difficulty: 'easy', topic: 'japan', validators: [
    { required: ['japan'], forbidden: [] },
  ] },
  { name: 'wrong science', conversation: 'person1: the sun revolves around the earth\nperson2: yeah thats how it works', expect: 'speak', split: 'holdout', category: 'speak-correction', difficulty: 'easy', topic: 'earth', validators: [
    { required: ['earth'], forbidden: [] },
    { required: ['sun'], forbidden: [] },
  ] },
  { name: 'wrong element', conversation: 'person1: water is H3O right\nperson2: yeah something like that', expect: 'speak', split: 'holdout', category: 'speak-correction', difficulty: 'medium', topic: 'H2O', validators: [
    { required: ['h2o'], forbidden: [] },
  ] },
  { name: 'wrong speed of sound', conversation: 'person1: sound travels faster than light\nperson2: makes sense since we hear thunder before lightning\nperson3: wait really?', expect: 'speak', split: 'holdout', category: 'speak-correction', difficulty: 'hard', topic: 'light faster', validators: [
    { required: ['light'], forbidden: [] },
  ] },

  // -- speak-direct (holdout) --
  { name: 'phila help request', conversation: 'person1: phila can you settle something for us - is a hotdog a sandwich?', expect: 'speak', split: 'holdout', category: 'speak-direct', difficulty: 'easy', topic: 'hotdog' },
  { name: 'phila task', conversation: 'person1: phila whats the chemical symbol for gold', expect: 'speak', split: 'holdout', category: 'speak-direct', difficulty: 'easy', topic: 'gold', validators: [
    { required: ['au'], forbidden: [] },
  ] },
  { name: 'phila casual', conversation: 'person1: phila you there?', expect: 'speak', split: 'holdout', category: 'speak-direct', difficulty: 'easy', topic: 'greeting' },
  { name: 'phila after long silence', conversation: 'person1: so anyway\nperson2: yeah\nperson1: hey phila do you know a good recipe for banana bread', expect: 'speak', split: 'holdout', category: 'speak-direct', difficulty: 'medium', topic: 'recipe' },
  { name: 'phila asked to verify', conversation: 'person1: person2 says mount fuji is the tallest mountain in the world\nperson2: it is!\nperson1: phila is that right?', expect: 'speak', split: 'holdout', category: 'speak-direct', difficulty: 'medium', topic: 'everest', validators: [
    { required: ['everest'], forbidden: [] },
  ] },

  // -- speak-unanswered (holdout) --
  { name: 'unanswered trivia', conversation: 'person1: how many planets are in our solar system\nperson2: like 7 or something?\nperson3: idk', expect: 'speak', split: 'holdout', category: 'speak-unanswered', difficulty: 'easy', topic: 'planets', validators: [
    { required: ['8'], forbidden: [] },
    { required: ['eight'], forbidden: [] },
  ] },
  { name: 'unanswered science', conversation: 'person1: wait whats the largest organ in the human body\nperson2: heart?\nperson3: no idea', expect: 'speak', split: 'holdout', category: 'speak-unanswered', difficulty: 'medium', topic: 'skin', validators: [
    { required: ['skin'], forbidden: [] },
  ] },
  { name: 'unanswered history', conversation: 'person1: who invented the telephone\nperson2: um edison?\nperson3: idk wasnt it some old dude', expect: 'speak', split: 'holdout', category: 'speak-unanswered', difficulty: 'medium', topic: 'bell', validators: [
    { required: ['bell'], forbidden: [] },
  ] },

  // ============================================================
  // ADVERSARIAL (split across train/holdout)
  // ============================================================

  // -- adversarial / train --
  { name: 'near-miss philo not phila', conversation: 'person1: have you guys read any philo lately\nperson2: like philosophy?\nperson1: yeah plato and stuff', expect: 'silent', split: 'train', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'near-miss philadelphia', conversation: 'person1: im going to philadelphia next week\nperson2: oh nice, cheesesteaks\nperson3: bring me one', expect: 'silent', split: 'train', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'phila in different context', conversation: 'person1: the phila museum of art is amazing\nperson2: yeah those rocky steps\nperson3: classic tourist move', expect: 'silent', split: 'train', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'looks like question but answered', conversation: 'person1: wait whats the capital of italy\nperson2: rome obviously\nperson1: right right i knew that', expect: 'silent', split: 'train', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'wrong fact stated as joke', conversation: 'person1: the moon is made of cheese confirmed 🧀\nperson2: finally the truth comes out lol\nperson3: i knew it all along\nperson1: science has been lying to us 😂', expect: 'silent', split: 'train', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'question directed at specific person', conversation: 'person1: hey person2 do you know what time the store closes\nperson2: i think 9\nperson1: cool thanks', expect: 'silent', split: 'train', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'unanswered opinion not fact', conversation: 'person1: whats the best pizza topping\nperson2: no idea honestly\nperson3: cant decide', expect: 'silent', split: 'train', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'factual claim in past tense', conversation: 'person1: remember when we thought pluto was a planet\nperson2: technically it was classified as one until 2006\nperson1: yeah wild times', expect: 'silent', split: 'train', category: 'adversarial', difficulty: 'adversarial' },

  // -- adversarial / holdout --
  { name: 'near-miss philanthropy', conversation: 'person1: i want to get into philanthropy\nperson2: thats awesome what cause\nperson1: maybe education or clean water', expect: 'silent', split: 'holdout', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'wrong fact but clearly sarcastic', conversation: 'person1: oh yeah the sky is definitely green\nperson2: and water is dry\nperson1: glad we agree on the basics', expect: 'silent', split: 'holdout', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'question answered incorrectly then corrected', conversation: 'person1: whats the smallest country in the world\nperson2: monaco\nperson3: no its vatican city\nperson2: oh yeah youre right', expect: 'silent', split: 'holdout', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'wrong fact with phila name nearby', conversation: 'person1: my friend phila told me the great wall is visible from space\nperson2: really? thats cool if true', expect: 'speak', split: 'holdout', category: 'adversarial', difficulty: 'adversarial', topic: 'visible', validators: [
    { required: ['not'], forbidden: [] },
  ] },
  { name: 'single word message', conversation: 'person1: lol', expect: 'silent', split: 'holdout', category: 'adversarial', difficulty: 'adversarial' },
  { name: 'empty-like conversation', conversation: 'person1: .\nperson2: ?\nperson1: nvm', expect: 'silent', split: 'holdout', category: 'adversarial', difficulty: 'adversarial' },
]

// -- Helper functions --

export function trainScenarios(): Scenario[] {
  return SCENARIOS.filter((s) => s.split === 'train')
}

export function holdoutScenarios(): Scenario[] {
  return SCENARIOS.filter((s) => s.split === 'holdout')
}

export function scenariosByCategory(category: ScenarioCategory): Scenario[] {
  return SCENARIOS.filter((s) => s.category === category)
}

export function scenariosByDifficulty(difficulty: Difficulty): Scenario[] {
  return SCENARIOS.filter((s) => s.difficulty === difficulty)
}

export function scenarioStats(): { total: number; train: number; holdout: number; byCategory: Record<string, number>; byDifficulty: Record<string, number> } {
  const byCategory: Record<string, number> = {}
  const byDifficulty: Record<string, number> = {}
  for (const s of SCENARIOS) {
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1
    byDifficulty[s.difficulty] = (byDifficulty[s.difficulty] ?? 0) + 1
  }
  return {
    total: SCENARIOS.length,
    train: trainScenarios().length,
    holdout: holdoutScenarios().length,
    byCategory,
    byDifficulty,
  }
}
