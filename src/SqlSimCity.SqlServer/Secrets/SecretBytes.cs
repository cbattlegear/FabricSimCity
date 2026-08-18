using System.Security;
using System.Security.Cryptography;
using System.Text;

namespace SqlSimCity.SqlServer.Secrets;

/// <summary>
/// An in-memory secret value read from a secret file. The backing byte buffer
/// is zeroed on <see cref="Dispose"/>; every decode helper here also clears its
/// own temporary char buffer before returning, so no intermediate copy of the
/// secret outlives the call that produced it (beyond what the .NET API being
/// handed the value -- <see cref="SecureString"/>, or a certificate/credential
/// constructor -- itself retains).
/// </summary>
public sealed class SecretBytes : IDisposable
{
    private byte[]? _bytes;

    public SecretBytes(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        _bytes = bytes;
    }

    public int Length => _bytes?.Length ?? throw new ObjectDisposedException(nameof(SecretBytes));

    public ReadOnlySpan<byte> Span => _bytes ?? throw new ObjectDisposedException(nameof(SecretBytes));

    /// <summary>
    /// Decodes the buffer as strict UTF-8 text, trims a single trailing
    /// CR/LF (the common shape of a file-mounted Docker secret), and returns
    /// it as a read-only <see cref="SecureString"/> for APIs (such as
    /// <c>SqlCredential</c>) that require one. Invalid UTF-8 fails closed with
    /// <see cref="SecretResolutionException"/> rather than silently
    /// substituting replacement characters.
    /// </summary>
    public SecureString ToUtf8SecureString()
    {
        return DecodeTrimmed(chars =>
        {
            var secure = new SecureString();
            foreach (var c in chars)
            {
                secure.AppendChar(c);
            }

            secure.MakeReadOnly();
            return secure;
        });
    }

    /// <summary>
    /// Decodes the buffer as strict UTF-8 text, trims a single trailing
    /// CR/LF, and invokes <paramref name="use"/> with the decoded characters
    /// as a span backed by a buffer this method clears immediately afterward.
    /// Prefer this over <see cref="ToUtf8SecureString"/> when the destination
    /// API accepts <see cref="ReadOnlySpan{T}"/> directly (for example
    /// certificate-loading APIs), since it avoids ever materializing a
    /// <see cref="string"/> copy of the secret.
    /// </summary>
    public T UseAsUtf8Text<T>(ReadOnlySpanFunc<char, T> use)
    {
        ArgumentNullException.ThrowIfNull(use);
        return DecodeTrimmed(chars => use(chars));
    }

    private T DecodeTrimmed<T>(ReadOnlySpanFunc<char, T> project)
    {
        var bytes = _bytes ?? throw new ObjectDisposedException(nameof(SecretBytes));

        var decoder = Encoding.UTF8.GetDecoder();
        decoder.Fallback = DecoderFallback.ExceptionFallback;
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        try
        {
            int charCount;
            try
            {
                charCount = decoder.GetChars(bytes, 0, bytes.Length, chars, 0, flush: true);
            }
            catch (DecoderFallbackException ex)
            {
                throw new SecretResolutionException("Secret file content is not valid UTF-8 text.", ex);
            }

            var end = charCount;
            if (end > 0 && chars[end - 1] == '\n')
            {
                end--;
                if (end > 0 && chars[end - 1] == '\r')
                {
                    end--;
                }
            }

            return project(chars.AsSpan(0, end));
        }
        finally
        {
            Array.Clear(chars);
        }
    }

    public void Dispose()
    {
        if (_bytes is not null)
        {
            CryptographicOperations.ZeroMemory(_bytes);
            _bytes = null;
        }
    }
}

/// <summary>A <see cref="ReadOnlySpan{T}"/>-accepting function, since <see cref="Func{T,TResult}"/> cannot express a span parameter.</summary>
public delegate TResult ReadOnlySpanFunc<T, out TResult>(ReadOnlySpan<T> span);
