import {
  AccountAddress,
  AssetCode,
  InvalidMetadataError,
  Metadata,
  MetadataLimitExceededError,
  Money,
} from '@ledger/domain';
import { Account, type IAccountProps } from './account.entity.js';

const usd = AssetCode.of('USD');
const eur = AssetCode.of('EUR');

const props = (): IAccountProps => ({
  address: AccountAddress.of('users:1'),
  allowOverdraft: false,
  metadata: Metadata.empty(),
  createdAt: new Date('2026-11-09T10:00:00.000Z'),
  balances: [Money.of(eur, 5n), Money.of(usd, 1050n)],
});

describe('Account', () => {
  describe('reconstitute', () => {
    it('gives back what it was made from', () => {
      const account = Account.reconstitute(props());

      expect(account.address.value).toBe('users:1');
      expect(account.allowOverdraft).toBe(false);
      expect(account.createdAt).toEqual(new Date('2026-11-09T10:00:00.000Z'));
      expect(account.balances.map((m) => [m.asset.value, m.amount])).toEqual([
        ['EUR', 5n],
        ['USD', 1050n],
      ]);
    });

    it('keeps the order of the balances it is given', () => {
      const account = Account.reconstitute({
        ...props(),
        balances: [Money.of(usd, 1n), Money.of(eur, 2n)],
      });

      expect(account.balances.map((m) => m.asset.value)).toEqual(['USD', 'EUR']);
    });

    it('can hold no balances, and a negative one when overdraft is allowed', () => {
      expect(Account.reconstitute({ ...props(), balances: [] }).balances).toEqual([]);

      const world = Account.reconstitute({
        ...props(),
        address: AccountAddress.WORLD,
        allowOverdraft: true,
        balances: [Money.of(usd, -1050n)],
      });
      expect(world.allowOverdraft).toBe(true);
      expect(world.balances[0]?.amount).toBe(-1050n);
    });
  });

  describe('immutability', () => {
    it('does not change when the list or the date it was made from changes', () => {
      const input = props();
      const balances = [...input.balances];
      const createdAt = new Date(input.createdAt);
      const account = Account.reconstitute({ ...input, balances, createdAt });

      balances.pop();
      createdAt.setFullYear(1999);

      expect(account.balances).toHaveLength(2);
      expect(account.createdAt).toEqual(new Date('2026-11-09T10:00:00.000Z'));
    });

    it('gives a frozen list of balances', () => {
      const account = Account.reconstitute(props());

      expect(Object.isFrozen(account.balances)).toBe(true);
    });

    it('gives a new date every time, so a caller cannot change the account through it', () => {
      const account = Account.reconstitute(props());

      account.createdAt.setFullYear(1999);

      expect(account.createdAt).toEqual(new Date('2026-11-09T10:00:00.000Z'));
      expect(account.createdAt).not.toBe(account.createdAt);
    });
  });

  describe('metadata', () => {
    const withEntries = (entries: Record<string, string>) =>
      Account.reconstitute({ ...props(), metadata: Metadata.of(entries) });

    it('gives back the metadata it was made from, and an empty one when there is none', () => {
      expect(withEntries({ customerId: 'c_42' }).metadata.entries).toEqual({ customerId: 'c_42' });
      expect(Account.reconstitute(props()).metadata.entries).toEqual({});
    });

    describe('withMetadata', () => {
      it('adds new keys and replaces a key that is there, and keeps the other keys', () => {
        const account = withEntries({ a: '1', b: '2' });

        const updated = account.withMetadata({ b: '3', c: '4' });

        expect(updated.metadata.entries).toEqual({ a: '1', b: '3', c: '4' });
      });

      it('keeps the address, the overdraft rule, the balances and the date', () => {
        const account = Account.reconstitute({
          ...props(),
          allowOverdraft: true,
          metadata: Metadata.of({ a: '1' }),
        });

        const updated = account.withMetadata({ b: '2' });

        expect(updated.address.value).toBe('users:1');
        expect(updated.allowOverdraft).toBe(true);
        expect(updated.createdAt).toEqual(account.createdAt);
        expect(updated.balances.map((m) => [m.asset.value, m.amount])).toEqual([
          ['EUR', 5n],
          ['USD', 1050n],
        ]);
      });

      it('does not change the account it was called on', () => {
        const account = withEntries({ a: '1' });

        account.withMetadata({ a: '2', b: '3' });

        expect(account.metadata.entries).toEqual({ a: '1' });
      });

      it('returns the same instance when every key already has this value', () => {
        const account = withEntries({ a: '1', b: '2' });

        expect(account.withMetadata({ a: '1' })).toBe(account);
        expect(account.withMetadata({})).toBe(account);
      });

      it('refuses an empty key', () => {
        expect(() => withEntries({}).withMetadata({ '': 'x' })).toThrow(InvalidMetadataError);
      });

      it('checks the limits on the result, so many small additions cannot pass them', () => {
        const full = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, 'v']));

        expect(() => withEntries(full).withMetadata({ oneMore: 'x' })).toThrow(
          MetadataLimitExceededError,
        );
        // Changing a key that is there does not add a key, so it is still allowed.
        expect(withEntries(full).withMetadata({ k0: 'new' }).metadata.size).toBe(128);
      });
    });

    describe('withoutMetadataKey', () => {
      it('removes only that key', () => {
        const updated = withEntries({ a: '1', b: '2' }).withoutMetadataKey('a');

        expect(updated.metadata.entries).toEqual({ b: '2' });
      });

      it('returns the same instance when the key is not there', () => {
        const account = withEntries({ a: '1' });

        expect(account.withoutMetadataKey('missing')).toBe(account);
      });

      it('does not change the account it was called on', () => {
        const account = withEntries({ a: '1' });

        account.withoutMetadataKey('a');

        expect(account.metadata.entries).toEqual({ a: '1' });
      });
    });
  });
});
