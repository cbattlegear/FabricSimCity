using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace SqlSimCity.Api.Social;

/// <summary>
/// Encodes an 8-bit RGB pixel buffer as a PNG.
/// </summary>
/// <remarks>
/// <para>
/// Hand-written rather than taken from an imaging package, because the alternative costs more than
/// it looks. This repository uses Central Package Management with a <c>packages.lock.json</c> in
/// every project and restores under <c>--locked-mode</c>, so one new package is a regeneration of
/// nineteen lock files and a new transitive surface to keep patched -- for the sake of writing a few
/// rectangles. The pieces this needs are all in the base class library: <see cref="ZLibStream"/> is
/// the compressed stream PNG asks for, and the only thing missing is CRC-32.
/// </para>
/// <para>
/// Truecolour without alpha (<c>colour type 2</c>), 8 bits per channel, no interlacing. The card is
/// opaque, and an alpha channel nothing reads would be a quarter more bytes on every request.
/// </para>
/// <para>
/// A hand-rolled encoder is not proven by its own tests -- they would agree with whatever it
/// produced. <c>tools/measure-browser/verify-social-card.js</c> decodes the output in Chromium and
/// checks the dimensions and sampled pixels against what was drawn.
/// </para>
/// </remarks>
public static class PngWriter
{
    private static readonly byte[] Signature = [137, 80, 78, 71, 13, 10, 26, 10];
    private static readonly uint[] CrcTable = BuildCrcTable();

    /// <summary>
    /// Encodes <paramref name="pixels"/>, which holds <c>width * height * 3</c> bytes in RGB order.
    /// </summary>
    public static byte[] Encode(ReadOnlySpan<byte> pixels, int width, int height)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(width, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(height, 1);
        var expected = checked(width * height * 3);
        if (pixels.Length != expected)
        {
            throw new ArgumentException(
                $"Expected {expected} bytes for a {width}x{height} RGB image but received {pixels.Length}.",
                nameof(pixels));
        }

        using var png = new MemoryStream(expected / 4);
        png.Write(Signature);

        Span<byte> header = stackalloc byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header[..4], width);
        BinaryPrimitives.WriteInt32BigEndian(header.Slice(4, 4), height);
        header[8] = 8;  // bit depth
        header[9] = 2;  // colour type: truecolour
        header[10] = 0; // compression: deflate
        header[11] = 0; // filter method: adaptive
        header[12] = 0; // interlace: none
        WriteChunk(png, "IHDR", header);
        WriteChunk(png, "IDAT", Compress(pixels, width, height));
        WriteChunk(png, "IEND", ReadOnlySpan<byte>.Empty);
        return png.ToArray();
    }

    /// <summary>
    /// Filters each scanline and deflates the result.
    /// </summary>
    /// <remarks>
    /// PNG prefixes every row with a filter byte, and choosing it well is most of the compression on
    /// an image like this one. A card is a vertical sky gradient with flat shapes over it: under
    /// <c>Up</c>, which subtracts the row above, the gradient's rows differ by a fraction of a step
    /// and most of the image becomes runs of zero. The three filters tried here are the cheap ones;
    /// the row is scored by the sum of absolute signed deviations, which is the heuristic the PNG
    /// specification itself suggests.
    /// </remarks>
    private static byte[] Compress(ReadOnlySpan<byte> pixels, int width, int height)
    {
        var stride = width * 3;
        var filtered = new byte[(stride + 1) * height];
        var none = new byte[stride];
        var sub = new byte[stride];
        var up = new byte[stride];

        for (var row = 0; row < height; row++)
        {
            var current = pixels.Slice(row * stride, stride);
            var previous = row == 0 ? ReadOnlySpan<byte>.Empty : pixels.Slice((row - 1) * stride, stride);

            long noneScore = 0, subScore = 0, upScore = 0;
            for (var at = 0; at < stride; at++)
            {
                var left = at >= 3 ? current[at - 3] : (byte)0;
                var above = previous.IsEmpty ? (byte)0 : previous[at];
                none[at] = current[at];
                sub[at] = (byte)(current[at] - left);
                up[at] = (byte)(current[at] - above);
                noneScore += Deviation(none[at]);
                subScore += Deviation(sub[at]);
                upScore += Deviation(up[at]);
            }

            var (type, chosen) = upScore <= subScore && upScore <= noneScore
                ? ((byte)2, up)
                : subScore <= noneScore ? ((byte)1, sub) : ((byte)0, none);

            var start = row * (stride + 1);
            filtered[start] = type;
            chosen.AsSpan().CopyTo(filtered.AsSpan(start + 1, stride));
        }

        using var deflated = new MemoryStream(filtered.Length / 8);
        using (var zlib = new ZLibStream(deflated, CompressionLevel.Optimal, leaveOpen: true))
        {
            zlib.Write(filtered);
        }

        return deflated.ToArray();
    }

    /// <summary>Distance from zero treating the byte as signed, which is what the heuristic scores.</summary>
    private static int Deviation(byte value) => value < 128 ? value : 256 - value;

    private static void WriteChunk(Stream png, string type, ReadOnlySpan<byte> data)
    {
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(length, data.Length);
        png.Write(length);

        Span<byte> label = stackalloc byte[4];
        Encoding.ASCII.GetBytes(type, label);
        png.Write(label);
        png.Write(data);

        Span<byte> checksum = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(checksum, Crc32(label, data));
        png.Write(checksum);
    }

    /// <summary>
    /// CRC-32 over a chunk's type and payload, as PNG specifies it: reflected, polynomial
    /// <c>0xEDB88320</c>, pre- and post-inverted.
    /// </summary>
    /// <remarks>
    /// The two spans are accumulated into one register rather than combined by chaining two finished
    /// checksums. Chaining would need the inversion undone between them, and the obvious way to spot
    /// that a caller had passed a partial result -- testing it against zero -- is wrong for the one
    /// partial result that legitimately is zero.
    /// </remarks>
    private static uint Crc32(ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        var register = Accumulate(Accumulate(0xFFFFFFFFu, type), data);
        return ~register;
    }

    private static uint Accumulate(uint register, ReadOnlySpan<byte> data)
    {
        foreach (var value in data)
        {
            register = CrcTable[(register ^ value) & 0xFF] ^ (register >> 8);
        }

        return register;
    }

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (var at = 0u; at < table.Length; at++)
        {
            var register = at;
            for (var bit = 0; bit < 8; bit++)
            {
                register = (register & 1) != 0 ? 0xEDB88320u ^ (register >> 1) : register >> 1;
            }

            table[at] = register;
        }

        return table;
    }
}
