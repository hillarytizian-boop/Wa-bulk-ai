// Which fields each smm.africa service type needs (from the API docs).
//  fields:     fields the customer must fill in (sent to the provider as-is; never "type")
//  linesFrom:  quantity is the number of non-empty lines in this field (and is NOT sent)
//  flat:       priced per order (the rate is not "per 1000")
const TYPES = {
  default: { name: 'Default', fields: ['link', 'quantity'] },
  package: { name: 'Package', fields: ['link'], flat: true },
  seo: { name: 'SEO', fields: ['link', 'quantity', 'keywords'] },
  'custom comments': { name: 'Custom Comments', fields: ['link', 'comments'], linesFrom: 'comments' },
  'custom comments package': { name: 'Custom Comments Package', fields: ['link', 'comments'], flat: true },
  'comment replies': { name: 'Comment Replies', fields: ['link', 'username', 'comments'], linesFrom: 'comments' },
  'comment likes': { name: 'Comment Likes', fields: ['link', 'username'], flat: true },
  mentions: { name: 'Mentions', fields: ['link', 'quantity', 'usernames'] },
  'mentions with hashtags': { name: 'Mentions with Hashtags', fields: ['link', 'quantity', 'usernames', 'hashtags'] },
  'mentions custom list': { name: 'Mentions Custom List', fields: ['link', 'usernames'], linesFrom: 'usernames' },
  'mentions hashtag': { name: 'Mentions Hashtag', fields: ['link', 'quantity', 'hashtags'] },
  'mentions user followers': { name: 'Mentions User Followers', fields: ['link', 'quantity', 'username'] },
  'mentions media likers': { name: 'Mentions Media Likers', fields: ['link', 'quantity', 'media'] },
  poll: { name: 'Poll', fields: ['link', 'quantity', 'answer'] },
  'invites from groups': { name: 'Invites from Groups', fields: ['link', 'quantity', 'groups'] },
  'web traffic': { name: 'Web Traffic', fields: ['quantity', 'country', 'device', 'type_of_traffic'] },
};

const FIELD_META = {
  link: { label: 'Link', multiline: false },
  quantity: { label: 'Quantity', multiline: false },
  keywords: { label: 'Keywords (one per line)', multiline: true },
  comments: { label: 'Comments (one per line)', multiline: true },
  username: { label: 'Username', multiline: false },
  usernames: { label: 'Usernames (one per line)', multiline: true },
  hashtags: { label: 'Hashtags (one per line)', multiline: true },
  media: { label: 'Media URL', multiline: false },
  answer: { label: 'Poll answer number', multiline: false },
  groups: { label: 'Groups (one per line)', multiline: true },
  country: { label: 'Country', multiline: false },
  device: { label: 'Device', multiline: false },
  type_of_traffic: { label: 'Type of traffic', multiline: false },
};

function getTypeDef(type) {
  return TYPES[String(type || 'Default').trim().toLowerCase()] || TYPES.default;
}

/** Count non-empty lines (custom comments / usernames / etc.). */
const countLines = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;

/** True when this type is priced per order instead of per 1000 units. */
const isFlat = (type) => Boolean(getTypeDef(type).flat);

module.exports = { TYPES, FIELD_META, getTypeDef, countLines, isFlat };
