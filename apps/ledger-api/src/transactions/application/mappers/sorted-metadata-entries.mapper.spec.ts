import { toSortedMetadataEntries } from './sorted-metadata-entries.mapper.js';

describe('toSortedMetadataEntries', () => {
  it('gives no pairs for no entries', () => {
    expect(toSortedMetadataEntries({})).toEqual([]);
  });

  it('sorts the pairs by key, whatever the order of the entries', () => {
    expect(toSortedMetadataEntries({ b: '2', a: '1', c: '3' })).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ]);
  });

  it('sorts by UTF-16 code units: uppercase before lowercase', () => {
    expect(toSortedMetadataEntries({ a: '1', B: '2' })).toEqual([
      ['B', '2'],
      ['a', '1'],
    ]);
  });
});
