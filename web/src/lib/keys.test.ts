// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RATES, isEditableTarget, keyToAction, stepRate } from './keys';

const k = (key: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe('keyToAction', () => {
  it('maps the player keys', () => {
    expect(keyToAction(k(' '))).toEqual({ type: 'togglePlay' });
    expect(keyToAction(k('k'))).toEqual({ type: 'togglePlay' });
    expect(keyToAction(k('ArrowLeft'))).toEqual({ type: 'seekBy', seconds: -10 });
    expect(keyToAction(k('j'))).toEqual({ type: 'seekBy', seconds: -10 });
    expect(keyToAction(k('ArrowRight'))).toEqual({ type: 'seekBy', seconds: 10 });
    expect(keyToAction(k('l'))).toEqual({ type: 'seekBy', seconds: 10 });
    expect(keyToAction(k('ArrowUp'))).toEqual({ type: 'volumeBy', delta: 0.1 });
    expect(keyToAction(k('ArrowDown'))).toEqual({ type: 'volumeBy', delta: -0.1 });
    expect(keyToAction(k('m'))).toEqual({ type: 'toggleMute' });
    expect(keyToAction(k('f'))).toEqual({ type: 'fullscreen' });
    expect(keyToAction(k('t'))).toEqual({ type: 'theatre' });
    expect(keyToAction(k('?', { shiftKey: true }))).toEqual({ type: 'help' });
  });
  it('caps lock / shift letters still work for the plain keys', () => {
    expect(keyToAction(k('K'))).toEqual({ type: 'togglePlay' });
    expect(keyToAction(k('F'))).toEqual({ type: 'fullscreen' });
  });
  it('Shift+N / Shift+P go to the next / previous lecture; plain n/p do nothing', () => {
    expect(keyToAction(k('N', { shiftKey: true }))).toEqual({ type: 'next' });
    expect(keyToAction(k('P', { shiftKey: true }))).toEqual({ type: 'prev' });
    expect(keyToAction(k('n'))).toBeNull();
    expect(keyToAction(k('p'))).toBeNull();
  });
  it('< and > step the speed', () => {
    expect(keyToAction(k('<', { shiftKey: true }))).toEqual({ type: 'rateStep', dir: -1 });
    expect(keyToAction(k('>', { shiftKey: true }))).toEqual({ type: 'rateStep', dir: 1 });
  });
  it('0–9 jump to 0–90 %', () => {
    expect(keyToAction(k('0'))).toEqual({ type: 'seekToFraction', fraction: 0 });
    expect(keyToAction(k('7'))).toEqual({ type: 'seekToFraction', fraction: 0.7 });
  });
  it('leaves browser shortcuts alone (Cmd/Ctrl/Alt)', () => {
    expect(keyToAction(k('f', { metaKey: true }))).toBeNull();
    expect(keyToAction(k('ArrowLeft', { ctrlKey: true }))).toBeNull();
    expect(keyToAction(k('k', { altKey: true }))).toBeNull();
  });
  it('unknown keys → null', () => {
    expect(keyToAction(k('x'))).toBeNull();
    expect(keyToAction(k('Enter'))).toBeNull();
  });
});

describe('isEditableTarget (keys are ignored while typing)', () => {
  it('detects inputs, textareas, selects and contenteditable', () => {
    const input = document.createElement('input');
    const range = document.createElement('input');
    range.type = 'range';
    const ta = document.createElement('textarea');
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true'); // jsdom has no contentEditable property
    const inner = document.createElement('span');
    div.append(inner);
    document.body.append(div);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(ta)).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
    expect(isEditableTarget(div)).toBe(true);
    expect(isEditableTarget(inner)).toBe(true);
    expect(isEditableTarget(range)).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('stepRate', () => {
  it('walks the 0.25 steps between 0.5 and 2 and clamps', () => {
    expect(RATES).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1, -1)).toBe(0.75);
    expect(stepRate(2, 1)).toBe(2);
    expect(stepRate(0.5, -1)).toBe(0.5);
    expect(stepRate(1.1, 1)).toBe(1.25); // an off-grid rate snaps to the next step
  });
});
