import { canonicalGmailAddress } from '../../scripts/gmailAlias';

describe('canonicalGmailAddress', () => {
  it('treats dots and googlemail as the same Gmail mailbox', () => {
    expect(canonicalGmailAddress('Andy.Allen.Huang@gmail.com')).toBe('andyallenhuang@gmail.com');
    expect(canonicalGmailAddress('andyallenhuang@googlemail.com')).toBe('andyallenhuang@gmail.com');
  });

  it('does not broaden recovery to plus aliases or non-Gmail domains', () => {
    expect(canonicalGmailAddress('andyallenhuang+test@gmail.com')).toBe('andyallenhuang+test@gmail.com');
    expect(canonicalGmailAddress('andy.allen.huang@example.com')).toBeNull();
  });
});
