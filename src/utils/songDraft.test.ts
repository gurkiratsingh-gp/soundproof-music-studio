import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSongs } from './initialSongs';
import { ADDITIONAL_INDIAN_LANGUAGES, INTERNATIONAL_LANGUAGES, LANGUAGES, SCHEDULED_INDIAN_LANGUAGES } from '../types';
import { DEFAULT_DRAFT, validateDraft } from './songDraft';

test('enhanced voice defaults on, preserves an explicit natural choice, and rejects invalid values', () => {
  assert.equal(DEFAULT_DRAFT.enhancedVoice, true);
  assert.equal(validateDraft(initialSongs[0]).enhancedVoice, true);
  assert.equal(validateDraft({ ...initialSongs[0], enhancedVoice: false }).enhancedVoice, false);
  assert.throws(() => validateDraft({ ...initialSongs[0], enhancedVoice: 'yes' }), /voice quality/);
});

test('language catalog contains all 22 scheduled Indian languages, regional additions, and existing international languages', () => {
  assert.equal(SCHEDULED_INDIAN_LANGUAGES.length, 22);
  assert.deepEqual(ADDITIONAL_INDIAN_LANGUAGES, ['Bhojpuri', 'Tulu', 'Pahadi']);
  assert.deepEqual(INTERNATIONAL_LANGUAGES, ['English', 'Spanish', 'French', 'Arabic', 'Korean', 'Japanese']);
  assert.equal(new Set(LANGUAGES).size, LANGUAGES.length);
  assert.equal(LANGUAGES.length, 31);
  for (const language of LANGUAGES) assert.equal(validateDraft({ ...initialSongs[0], language }).language, language);
  assert.throws(() => validateDraft({ ...initialSongs[0], language: 'Unsupported' }), /supported songwriting language/);
});

test('draft validation preserves Unicode lyrics and prompts without transliteration', () => {
  const nativeSamples = [
    ['Assamese', 'জোনাক ভৰা ৰাতি'],
    ['Tamil', 'மழையில் பாடும் மனம்'],
    ['Manipuri', 'ꯅꯣꯡꯃꯥꯏ ꯅꯨꯡꯁꯤꯕꯥ'],
    ['Santali', 'ᱥᱮᱫᱟᱭ ᱨᱮᱭᱟᱜ ᱥᱮᱨᱮᱧ'],
    ['Urdu', 'بارش میں دل گاتا ہے'],
    ['Tulu', 'ಎನ್ನ ಹೃದಯದ ಪಾಡ್ದನ'],
    ['Pahadi', 'पहाड़ों में गूंजे गीत'],
  ] as const;
  for (const [language, line] of nativeSamples) {
    const result = validateDraft({ ...initialSongs[0], language, description: line, title: line, lyrics: [{ section: 'Verse', lines: [line] }] });
    assert.equal(result.description, line);
    assert.equal(result.title, line);
    assert.equal(result.lyrics?.[0].lines[0], line);
  }
});
