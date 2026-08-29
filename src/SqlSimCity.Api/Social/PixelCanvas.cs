namespace SqlSimCity.Api.Social;

/// <summary>A colour channel triple, 0-255 each.</summary>
public readonly record struct Rgb(byte R, byte G, byte B)
{
    /// <summary>Reads a <c>0xRRGGBB</c> literal, which is how the app's palettes are written.</summary>
    public static Rgb FromHex(int packed) =>
        new((byte)((packed >> 16) & 0xFF), (byte)((packed >> 8) & 0xFF), (byte)(packed & 0xFF));

    /// <summary>Mixes towards <paramref name="other"/>, where 0 is this colour and 1 is that one.</summary>
    public Rgb Blend(Rgb other, double amount)
    {
        var mix = Math.Clamp(amount, 0, 1);
        return new Rgb(
            (byte)Math.Round(R + ((other.R - R) * mix)),
            (byte)Math.Round(G + ((other.G - G) * mix)),
            (byte)Math.Round(B + ((other.B - B) * mix)));
    }

    /// <summary>Scales all three channels, for a lit face against a shaded one.</summary>
    public Rgb Scale(double factor) => new(
        (byte)Math.Clamp(Math.Round(R * factor), 0, 255),
        (byte)Math.Clamp(Math.Round(G * factor), 0, 255),
        (byte)Math.Clamp(Math.Round(B * factor), 0, 255));
}

/// <summary>
/// An RGB pixel buffer with the handful of drawing operations the card needs.
/// </summary>
/// <remarks>
/// Everything clips to the buffer rather than throwing. The renderer positions text from measured
/// widths and towers from data, so an over-long name or an unusually tall tower should be cropped by
/// the frame in the way a drawing is, not turn a share card into a 500.
/// </remarks>
public sealed class PixelCanvas
{
    private readonly byte[] pixels;

    public PixelCanvas(int width, int height)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(width, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(height, 1);
        Width = width;
        Height = height;
        pixels = new byte[checked(width * height * 3)];
    }

    public int Width { get; }

    public int Height { get; }

    public ReadOnlySpan<byte> Pixels => pixels;

    /// <summary>Encodes the buffer as a PNG.</summary>
    public byte[] ToPng() => PngWriter.Encode(pixels, Width, Height);

    /// <summary>Reads one pixel, for tests and for blending.</summary>
    public Rgb this[int x, int y]
    {
        get
        {
            var at = ((y * Width) + x) * 3;
            return new Rgb(pixels[at], pixels[at + 1], pixels[at + 2]);
        }
    }

    public void Set(int x, int y, Rgb colour)
    {
        if ((uint)x >= (uint)Width || (uint)y >= (uint)Height) return;
        var at = ((y * Width) + x) * 3;
        pixels[at] = colour.R;
        pixels[at + 1] = colour.G;
        pixels[at + 2] = colour.B;
    }

    public void Blend(int x, int y, Rgb colour, double alpha)
    {
        if (alpha <= 0) return;
        if ((uint)x >= (uint)Width || (uint)y >= (uint)Height) return;
        Set(x, y, alpha >= 1 ? colour : this[x, y].Blend(colour, alpha));
    }

    public void Fill(int x, int y, int width, int height, Rgb colour) => Fill(x, y, width, height, colour, 1);

    public void Fill(int x, int y, int width, int height, Rgb colour, double alpha)
    {
        var left = Math.Max(0, x);
        var top = Math.Max(0, y);
        var right = Math.Min(Width, x + width);
        var bottom = Math.Min(Height, y + height);
        for (var row = top; row < bottom; row++)
        {
            for (var column = left; column < right; column++)
            {
                Blend(column, row, colour, alpha);
            }
        }
    }

    /// <summary>
    /// Paints a vertical gradient between two rows, holding the end colours beyond them.
    /// </summary>
    public void VerticalGradient(int fromY, int toY, Rgb fromColour, Rgb toColour)
    {
        if (toY <= fromY) return;
        for (var row = Math.Max(0, fromY); row < Math.Min(Height, toY); row++)
        {
            var colour = fromColour.Blend(toColour, (double)(row - fromY) / (toY - fromY));
            for (var column = 0; column < Width; column++)
            {
                Set(column, row, colour);
            }
        }
    }

    /// <summary>
    /// Draws upper-cased <paramref name="text"/> with its top-left corner at
    /// <paramref name="x"/>, <paramref name="y"/>, each font pixel a <paramref name="scale"/>-square block.
    /// </summary>
    public void DrawText(string text, int x, int y, int scale, Rgb colour)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentOutOfRangeException.ThrowIfLessThan(scale, 1);
        var pen = x;
        foreach (var character in text)
        {
            var glyph = PixelFont.Glyph(character);
            for (var row = 0; row < PixelFont.GlyphHeight; row++)
            {
                for (var column = 0; column < PixelFont.GlyphWidth; column++)
                {
                    if (glyph[row][column] != '#') continue;
                    Fill(pen + (column * scale), y + (row * scale), scale, scale, colour);
                }
            }

            pen += (PixelFont.GlyphWidth + PixelFont.Tracking) * scale;
        }
    }

    /// <summary>
    /// Draws text over a dropped shadow, so it stays legible wherever it lands.
    /// </summary>
    /// <remarks>
    /// The card's background is a gradient with buildings in it, and the renderer places text by
    /// measurement rather than by looking at what is underneath. A one-block shadow is what makes the
    /// placement safe: pale text over the bright horizon band is the case that would otherwise
    /// disappear, and it is exactly where the headline sits.
    /// </remarks>
    public void DrawTextWithShadow(string text, int x, int y, int scale, Rgb colour, Rgb shadow)
    {
        DrawText(text, x + scale, y + scale, scale, shadow);
        DrawText(text, x, y, scale, colour);
    }
}
