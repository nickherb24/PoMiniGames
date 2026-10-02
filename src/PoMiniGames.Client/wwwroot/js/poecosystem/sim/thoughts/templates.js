// templates.js — thoughts without a model: chosen by species and the dominant
// drive, flavoured by the dominant trait. Templates never apply nudges.
import { dominantDrive } from '../creatures/drives.js';
import { dominantTrait } from '../creatures/traits.js';

const LINES = [
  { // rabbit
    hunger: ['The clover by the hollow is sweetest.', 'Grass. Grass. More grass.', 'My belly aches for the green.', 'Nibble fast, listen faster.'],
    thirst: ['I can smell the lake from here.', 'Dew is never enough.', 'To the water, quick as a hop.', 'My throat is dry as the beach.'],
    content: ['Warm sun, full belly, twitchy nose.', 'The warren is quiet today.', 'I could dig a little.', 'Nothing hunts me right now. Right now.'],
  },
  { // deer
    hunger: ['The meadow past the trees looks untouched.', 'Graze low, keep my head up.', 'Hunger makes the forest louder.', 'Every step, a mouthful.'],
    thirst: ['The lake is worth the open ground.', 'I must drink before dark.', 'The wolves know where the water is too.', 'Dust in my mouth.'],
    content: ['The herd moves like one animal.', 'I like the smell of the hills after rain.', 'Stay with the others. Always the others.', 'The forest edge is my edge.'],
  },
  { // wolf
    hunger: ['Rabbits scatter but deer tire.', 'The pack eats when I say.', 'I smell blood on the wind.', 'Hunger sharpens everything.'],
    thirst: ['Down to the shore, then back to the hunt.', 'Water first, then teeth.', 'The lake smells of deer and dusk.', 'A dry throat makes a slow chase.'],
    content: ['The island is mine, tree by tree.', 'The pups sleep. Good.', 'I could run until the sea stops me.', 'The pack is fed. I am fed.'],
  },
  { // human
    hunger: ['Berries by the forest edge, if the deer left any.', 'A spear, a rabbit, a meal.', 'The village will want meat tonight.', 'Hunger is a good hunter.'],
    thirst: ['The lake water is cold and clean.', 'One more jar for the hut.', 'Thirst is a walk away, no more.', 'I will drink, then think.'],
    content: ['One more hut and we could take in another family.', 'The mountain smokes. It always smokes.', 'The children are growing faster than the huts.', 'A good day to fell a tree.'],
  },
];

const TRAIT_FLAVOUR = {
  boldness: ' Let the wolves come.', sociability: ' Better together.', curiosity: ' What is over that ridge?',
  greed: ' Mine first.', diligence: ' There is work to do.',
};

export function templateThought(world, i, rng) {
  const e = world.entities;
  const table = LINES[e.species[i]] ?? LINES[0];
  const drive = dominantDrive(e, i);
  const lines = table[drive] ?? table.content;
  let text = lines[rng.int(lines.length)];
  if (rng.next() < 0.5) text += TRAIT_FLAVOUR[dominantTrait(e, i)] ?? '';
  return text;
}
