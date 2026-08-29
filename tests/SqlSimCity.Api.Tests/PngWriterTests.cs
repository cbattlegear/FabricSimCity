using System.IO.Compression;
using System.Text;
using SqlSimCity.Api.Social;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Structural checks on the hand-rolled PNG encoder, decoded independently of the code that wrote it.
/// </summary>
/// <remarks>
/// A hand-rolled encoder cannot be proved correct by tests that reuse its own helpers -- they would
/// agree with whatever it produced. So the chunk walk, the CRC and the inflate here are written out
/// separately, and the pixels come back through <see cref="ZLibStream"/> rather than through anything
/// in <see cref="PngWriter"/>. What this cannot prove is that a decoder in the wild accepts the file;
/// that is what the browser check in <c>tools/measure-browser</c> is for.
/// </remarks>
public sealed class PngWriterTests
{
    private static byte[] Solid(int width, int height, byte r, byte g, byte b)
    {
        var pixels = new byte[width * height * 3];
        for (var index = 0; index < pixels.Length; index += 3)
        {
            pixels[index] = r;
            pixels[index + 1] = g;
            pixels[index + 2] = b;
        }

        return pixels;
    }

    [Fact]
    public void FileStartsWithThePngSignature()
    {
        var png = PngWriter.Encode(Solid(4, 4, 1, 2, 3), 4, 4);

        Assert.Equal<byte>([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], png[..8]);
    }

    [Fact]
    public void HeaderDeclaresTruecolourAtTheRequestedSize()
    {
        var png = PngWriter.Encode(Solid(1200, 630, 0, 0, 0), 1200, 630);

        var header = Chunks(png).First(chunk => chunk.Type == "IHDR").Data;
        Assert.Equal(1200, ReadInt32(header, 0));
        Assert.Equal(630, ReadInt32(header, 4));
        Assert.Equal(8, header[8]);
        Assert.Equal(2, header[9]);
        Assert.Equal(0, header[10]);
        Assert.Equal(0, header[11]);
        Assert.Equal(0, header[12]);
    }

    [Fact]
    public void ChunksAppearInOrderAndTheFileEndsWithIend()
    {
        var types = Chunks(PngWriter.Encode(Solid(8, 8, 9, 9, 9), 8, 8)).Select(chunk => chunk.Type).ToList();

        Assert.Equal("IHDR", types[0]);
        Assert.Contains("IDAT", types);
        Assert.Equal("IEND", types[^1]);
    }

    /// <summary>
    /// The CRC is the part most likely to be silently wrong: a bad one still produces a plausible
    /// file, and some decoders will render it anyway.
    /// </summary>
    [Fact]
    public void EveryChunkCarriesACorrectCrc()
    {
        var png = PngWriter.Encode(Solid(37, 11, 200, 100, 50), 37, 11);

        foreach (var chunk in Chunks(png))
        {
            var covered = new byte[4 + chunk.Data.Length];
            Encoding.ASCII.GetBytes(chunk.Type).CopyTo(covered, 0);
            chunk.Data.CopyTo(covered, 4);
            Assert.Equal(Crc32(covered), chunk.Crc);
        }
    }

    /// <summary>
    /// Filtering is chosen per scanline, so a round trip is the only thing that shows every branch
    /// reconstructs to the pixels that went in.
    /// </summary>
    [Fact]
    public void PixelsSurviveARoundTrip()
    {
        const int width = 61;
        const int height = 23;
        var pixels = new byte[width * height * 3];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var offset = ((y * width) + x) * 3;

                // A vertical ramp, a horizontal ramp and a constant, which between them make each of
                // the None, Sub and Up filters the cheapest choice on some row.
                pixels[offset] = (byte)(y * 7);
                pixels[offset + 1] = (byte)(x * 3);
                pixels[offset + 2] = 128;
            }
        }

        Assert.Equal(pixels, Decode(PngWriter.Encode(pixels, width, height), width, height));
    }

    [Fact]
    public void ZeroSizedImagesAreRejectedRatherThanWrittenMalformed()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => PngWriter.Encode([], 0, 4));
        Assert.Throws<ArgumentOutOfRangeException>(() => PngWriter.Encode([], 4, 0));
    }

    [Fact]
    public void PixelBufferMustMatchTheDeclaredSize()
    {
        Assert.Throws<ArgumentException>(() => PngWriter.Encode(Solid(4, 4, 0, 0, 0), 5, 4));
    }

    private static byte[] Decode(byte[] png, int width, int height)
    {
        var compressed = Chunks(png)
            .Where(chunk => chunk.Type == "IDAT")
            .SelectMany(chunk => chunk.Data)
            .ToArray();

        using var input = new MemoryStream(compressed);
        using var inflate = new ZLibStream(input, CompressionMode.Decompress);
        using var raw = new MemoryStream();
        inflate.CopyTo(raw);
        var filtered = raw.ToArray();

        const int bytesPerPixel = 3;
        var stride = width * bytesPerPixel;
        var pixels = new byte[stride * height];
        for (var y = 0; y < height; y++)
        {
            var filter = filtered[y * (stride + 1)];
            for (var x = 0; x < stride; x++)
            {
                var value = filtered[(y * (stride + 1)) + 1 + x];
                var left = x >= bytesPerPixel ? pixels[(y * stride) + x - bytesPerPixel] : 0;
                var up = y > 0 ? pixels[((y - 1) * stride) + x] : 0;
                pixels[(y * stride) + x] = filter switch
                {
                    0 => value,
                    1 => (byte)(value + left),
                    2 => (byte)(value + up),
                    _ => throw new InvalidDataException($"Unexpected filter {filter} on row {y}."),
                };
            }
        }

        return pixels;
    }

    private static IEnumerable<(string Type, byte[] Data, uint Crc)> Chunks(byte[] png)
    {
        var offset = 8;
        while (offset + 12 <= png.Length)
        {
            var length = ReadInt32(png, offset);
            var type = Encoding.ASCII.GetString(png, offset + 4, 4);
            var data = png[(offset + 8)..(offset + 8 + length)];
            var crc = (uint)ReadInt32(png, offset + 8 + length);
            yield return (type, data, crc);
            offset += 12 + length;
        }
    }

    private static int ReadInt32(byte[] buffer, int offset) =>
        (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];

    private static uint Crc32(byte[] data)
    {
        var crc = 0xFFFFFFFFU;
        foreach (var value in data)
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++)
            {
                crc = (crc & 1) != 0 ? 0xEDB88320U ^ (crc >> 1) : crc >> 1;
            }
        }

        return ~crc;
    }
}
