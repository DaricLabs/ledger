import { AccountAddress, AssetCode, Money } from '@ledger/domain';
import { Account, type AccountProps } from './account.entity.js';

const usd = AssetCode.of('USD');
const eur = AssetCode.of('EUR');

const props = (): AccountProps => ({
  address: AccountAddress.of('users:1'),
  allowOverdraft: false,
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
});
