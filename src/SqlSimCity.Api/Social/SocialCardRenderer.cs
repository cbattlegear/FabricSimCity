using System.Globalization;

namespace SqlSimCity.Api.Social;

/// <summary>
/// One building on the skyline.
/// </summary>
/// <param name="Height">Relative height in 0..1. Ignored when <paramref name="Measured"/> is false.</param>
/// <param name="Measured">
/// False for a database or object this instance knows exists but has no size for. Those are drawn as
/// cleared lots rather than dropped, because the stats line counts them: a card reading "8 databases"
/// over six towers looks like the picture lost something, and the honest answer is that two of them
/// have not been measured, not that they are small.
/// </param>
public readonly record struct SocialCardTower(double Height, bool Measured);

/// <summary>
/// What a card draws: the words on it, and a skyline measured from real data.
/// </summary>
/// <param name="Kicker">Small line above the headline, naming the level.</param>
/// <param name="Headline">The database name, or the product name for the atlas.</param>
/// <param name="Saying">The line borrowed from the loading screen.</param>
/// <param name="Stats">Measured summary drawn at the foot, or empty when nothing was measured.</param>
/// <param name="Towers">
/// The skyline, left to right. Empty draws an empty lot rather than inventing a skyline, which is the
/// same rule the rest of the app follows about absent evidence.
/// </param>
public sealed record SocialCardScene(
    string Kicker,
    string Headline,
    string Saying,
    string Stats,
    IReadOnlyList<SocialCardTower> Towers);

/// <summary>
/// Draws the share card: a dusk skyline under the name of whatever the link opens.
/// </summary>
/// <remarks>
/// <para>
/// The palette is the app's own <c>evening</c> grade from <c>web/src/timeOfDay.ts</c>, so the card
/// and the thing it links to are recognisably the same city at the same hour. The screenshots in the
/// README are captured at that hour for the same reason.
/// </para>
/// <para>
/// The skyline is measurement, not decoration. Tower heights come from allocated bytes for the atlas
/// and from the city's own objects for a database, so two links to two different databases produce
/// two different pictures, and a small database is visibly a small one. Nothing is drawn when there
/// is nothing to draw from.
/// </para>
/// </remarks>
public static class SocialCardRenderer
{
    private static readonly Rgb SkyZenith = Rgb.FromHex(0x14203C);
    private static readonly Rgb SkyUpper = Rgb.FromHex(0x3C4A72);
    private static readonly Rgb SkyHorizon = Rgb.FromHex(0xF0B072);
    private static readonly Rgb Ground = Rgb.FromHex(0x2A2432);
    private static readonly Rgb Haze = Rgb.FromHex(0xC6A184);
    private static readonly Rgb Key = Rgb.FromHex(0xFFC286);
    private static readonly Rgb Window = Rgb.FromHex(0xFFD9A0);
    private static readonly Rgb Ink = Rgb.FromHex(0x0B1020);
    private static readonly Rgb Paper = Rgb.FromHex(0xF6EFE6);

    // The card is divided once, and every other number here is derived from that division. Words own
    // everything above TowerCeiling; the city owns everything below it. Nothing is positioned by eye,
    // because a headline is a variable-length string and a skyline is variable-length data, and the
    // only way the two reliably miss each other is for them to be given separate rooms.
    private const int HorizonY = 500;
    private const int TowerCeiling = 268;
    private const int Margin = 60;

    /// <summary>Renders <paramref name="scene"/> as a PNG at the card's declared dimensions.</summary>
    public static byte[] Render(SocialCardScene scene)
    {
        ArgumentNullException.ThrowIfNull(scene);
        var canvas = new PixelCanvas(SocialDocument.CardWidth, SocialDocument.CardHeight);
        PaintSky(canvas);
        PaintSkyline(canvas, scene);
        PaintGround(canvas);
        PaintScrim(canvas);
        PaintText(canvas, scene);
        PaintFrame(canvas);
        return canvas.ToPng();
    }

    private static void PaintSky(PixelCanvas canvas)
    {
        canvas.VerticalGradient(0, 330, SkyZenith, SkyUpper);
        canvas.VerticalGradient(330, HorizonY, SkyUpper, SkyHorizon);

        // The sun, low and to the right, which is where the app's evening key light comes from. Drawn
        // as concentric discs rather than a true radial falloff: at this size the banding is not
        // visible and the arithmetic stays something a reader can check.
        const int sunX = 1010;
        const int sunY = HorizonY - 46;
        for (var radius = 104; radius >= 0; radius -= 1)
        {
            var glow = 1 - (radius / 104.0);
            Disc(canvas, sunX, sunY, radius, Key, Math.Pow(glow, 2.6) * 0.85);
        }
    }

    private static void Disc(PixelCanvas canvas, int centreX, int centreY, int radius, Rgb colour, double alpha)
    {
        for (var y = centreY - radius; y <= centreY + radius; y++)
        {
            var span = (int)Math.Sqrt((radius * radius) - ((y - centreY) * (y - centreY)));
            canvas.Fill(centreX - span, y, (span * 2) + 1, 1, colour, alpha);
        }
    }

    /// <summary>
    /// Stands one tower per measured value along the horizon.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Widths and window patterns are derived from the tower's own index and height rather than from
    /// a random number generator, so the same data always draws the same picture. That matters more
    /// than it sounds: a preview client fetches the image more than once, and a skyline that
    /// reshuffled between fetches would look like a bug in the thing it is advertising.
    /// </para>
    /// <para>
    /// The row is centred and its slot width is capped, so a server holding eight databases draws a
    /// compact downtown with open horizon either side rather than eight card-wide slabs. Uncapped,
    /// few-but-wide is the shape that reads as a bar chart, which is the one thing this must not
    /// look like.
    /// </para>
    /// </remarks>
    private static void PaintSkyline(PixelCanvas canvas, SocialCardScene scene)
    {
        if (scene.Towers.Count == 0) return;

        const int available = SocialDocument.CardWidth - (Margin * 2);
        const int maximumSlot = 82;
        var count = scene.Towers.Count;
        var slot = Math.Max(9, Math.Min(maximumSlot, available / count));
        var left = (SocialDocument.CardWidth - (slot * count)) / 2;
        var gap = Math.Max(3, slot / 6);

        for (var index = 0; index < count; index++)
        {
            var tower = scene.Towers[index];

            // Widths vary within the slot, and a uniform pitch is exactly what makes a row of
            // rectangles read as a chart. The variation is a function of the index so it is stable
            // across the repeated fetches a preview client makes.
            var room = slot - gap;
            var width = Math.Max(8, room - ((index % 3) * Math.Max(1, room / 7)));
            var x = left + (index * slot) + ((room - width) / 2);

            if (!tower.Measured)
            {
                PaintClearedLot(canvas, x, width, index);
                continue;
            }

            var height = (int)Math.Round(Math.Clamp(tower.Height, 0, 1) * (HorizonY - TowerCeiling - 52)) + 52;
            var top = HorizonY - height;

            // Further-back towers sit in more haze, which is what stops a row of flat rectangles
            // reading as a bar chart. The alternation is by index so it stays deterministic.
            var depth = (index % 4) / 6.0;
            var face = Rgb.FromHex(0x161E33).Blend(Haze, depth * 0.5);
            var lit = face.Blend(Key, 0.32 - (depth * 0.1));

            canvas.Fill(x, top, width, height, face);
            canvas.Fill(x + width - Math.Max(3, width / 7), top, Math.Max(3, width / 7), height, lit);
            canvas.Fill(x, top, width, 3, lit.Scale(1.14));

            // A roof box on the taller towers, which is most of what separates a skyline from a
            // histogram at this resolution.
            if (height > 120 && width >= 22 && index % 2 == 0)
            {
                var capWidth = Math.Max(6, width / 3);
                canvas.Fill(x + ((width - capWidth) / 2), top - 14, capWidth, 14, face);
                canvas.Fill(x + ((width - capWidth) / 2), top - 14, capWidth, 2, lit.Scale(1.14));
            }

            PaintWindows(canvas, x, top, width, index);
        }
    }

    /// <summary>
    /// A plot with no building on it, for a database or object whose size was never measured.
    /// </summary>
    /// <remarks>
    /// Deliberately not a short tower. A short tower is a claim -- it says this thing is small -- and
    /// nothing here measured it. A hoarding around bare ground says the plot exists and the survey
    /// does not, which is the true statement and the one the rest of the app makes about missing data.
    /// </remarks>
    private static void PaintClearedLot(PixelCanvas canvas, int x, int width, int index)
    {
        var dirt = Ground.Blend(Ink, 0.30);
        var hoarding = Ground.Blend(Haze, 0.34);

        canvas.Fill(x, HorizonY - 10, width, 10, dirt);
        canvas.Fill(x, HorizonY - 12, width, 2, hoarding, 0.85);

        // Posts, so it reads as a fenced site rather than a smear on the horizon.
        for (var post = x; post < x + width - 1; post += 9)
        {
            canvas.Fill(post, HorizonY - 19, 2, 9, hoarding, 0.5 + (((post + index) % 3) * 0.12));
        }
    }

    private static void PaintWindows(PixelCanvas canvas, int x, int top, int width, int index)
    {
        var pitch = width >= 26 ? 11 : 8;
        var pane = pitch >= 11 ? 4 : 3;
        for (var row = top + 12; row < HorizonY - 10; row += pitch)
        {
            for (var column = x + 5; column < x + width - pane - 3; column += pitch)
            {
                // A cheap deterministic hash of the cell, so about a third of the windows are lit and
                // the pattern differs between towers without being random.
                var cell = (row * 31) + (column * 17) + (index * 131);
                if (cell % 3 != 0) continue;
                canvas.Fill(column, row, pane, pane + 1, Window, cell % 7 == 0 ? 0.85 : 0.45);
            }
        }
    }

    /// <summary>
    /// Lays the ground out as a plan in perspective rather than as flat bands.
    /// </summary>
    /// <remarks>
    /// Evenly spaced horizontal rules read as scanlines and make the lower third look like a
    /// rendering fault. Streets converging on a vanishing point read as ground, and cost the same.
    /// </remarks>
    private static void PaintGround(PixelCanvas canvas)
    {
        var depth = canvas.Height - HorizonY;
        canvas.Fill(0, HorizonY, canvas.Width, depth, Ground);

        // A warm wash immediately below the horizon, so the ground reads as lit by the same sun.
        canvas.VerticalGradient(HorizonY, HorizonY + 30, Ground.Blend(Haze, 0.38), Ground);

        var street = Ground.Blend(Paper, 0.34);
        const int vanishingX = 600;

        // The sun lands on the ground too, or the lower half looks like a different picture.
        for (var y = HorizonY; y < canvas.Height; y++)
        {
            var progress = (double)(y - HorizonY) / depth;
            var width = 150 + (int)(progress * 320);
            canvas.Fill(1010 - width, y, width * 2, 1, Key, 0.16 * (1 - progress) * (1 - progress));
        }

        // Streets running away from the viewer, spaced on the bottom edge and converging on the
        // horizon. Spacing on the near edge is what makes them look evenly spaced on the ground.
        for (var edge = -1400; edge <= 2600; edge += 190)
        {
            for (var y = HorizonY + 2; y < canvas.Height; y++)
            {
                var progress = (double)(y - HorizonY) / depth;
                var x = (int)Math.Round(vanishingX + ((edge - vanishingX) * progress));
                canvas.Fill(x, y, 1 + (int)(progress * 2), 1, street, 0.16 + (progress * 0.30));
            }
        }

        // Cross streets, spaced geometrically so they crowd towards the horizon the way real ones do.
        var spacing = 4.0;
        var cross = HorizonY + 5.0;
        while (cross < canvas.Height)
        {
            var progress = (cross - HorizonY) / depth;
            canvas.Fill(0, (int)cross, canvas.Width, 1 + (int)(progress * 2), street, 0.14 + (progress * 0.26));
            cross += spacing;
            spacing *= 1.44;
        }
    }

    /// <summary>
    /// A scrim that fades out over the gap between the words and the tower ceiling.
    /// </summary>
    /// <remarks>
    /// Two flat bands of different opacity — the obvious way to do this — put two horizontal seams
    /// across the sky that look like colour banding in the gradient underneath. Ramping per scanline
    /// costs one pass and leaves no edge to see.
    /// </remarks>
    private static void PaintScrim(PixelCanvas canvas)
    {
        const int solid = 200;
        for (var y = 0; y < TowerCeiling; y++)
        {
            var alpha = y <= solid
                ? 0.54
                : 0.54 * (1 - ((double)(y - solid) / (TowerCeiling - solid)));
            canvas.Fill(0, y, canvas.Width, 1, Ink, alpha);
        }
    }

    /// <summary>
    /// A thin inset rule, which is what stops the card dissolving into a light chat background.
    /// </summary>
    private static void PaintFrame(PixelCanvas canvas)
    {
        var edge = Paper.Blend(Ink, 0.35);
        canvas.Fill(0, 0, canvas.Width, 4, Ink, 0.55);
        canvas.Fill(0, canvas.Height - 4, canvas.Width, 4, Ink, 0.55);
        canvas.Fill(24, 24, canvas.Width - 48, 1, edge, 0.32);
        canvas.Fill(24, canvas.Height - 25, canvas.Width - 48, 1, edge, 0.32);
        canvas.Fill(24, 24, 1, canvas.Height - 48, edge, 0.32);
        canvas.Fill(canvas.Width - 25, 24, 1, canvas.Height - 48, edge, 0.32);
    }

    private static void PaintText(PixelCanvas canvas, SocialCardScene scene)
    {
        canvas.DrawText(Fold(scene.Kicker), Margin, 62, 3, Key);
        canvas.DrawTextWithShadow(
            Fit(scene.Headline, Margin, HeadlineScale(scene.Headline)),
            Margin,
            98,
            HeadlineScale(scene.Headline),
            Paper,
            Ink);
        canvas.DrawText(Fit(scene.Saying + "\u2026", Margin, 4), Margin + 2, 186, 4, Haze);

        if (scene.Stats.Length > 0)
        {
            canvas.DrawTextWithShadow(
                Fit(scene.Stats, Margin, 3),
                Margin,
                canvas.Height - 62,
                3,
                Paper,
                Ink);
        }
    }

    /// <summary>Shrinks the headline a step at a time until it fits, rather than clipping a name.</summary>
    private static int HeadlineScale(string headline)
    {
        var folded = Fold(headline);
        for (var scale = 8; scale > 3; scale--)
        {
            if (PixelFont.Measure(folded, scale) <= SocialDocument.CardWidth - 120) return scale;
        }

        return 3;
    }

    /// <summary>Upper-cases and truncates to what will fit on one line at <paramref name="scale"/>.</summary>
    private static string Fit(string text, int margin, int scale)
    {
        var folded = Fold(text);
        var room = SocialDocument.CardWidth - (margin * 2);
        if (PixelFont.Measure(folded, scale) <= room) return folded;
        var characters = Math.Max(1, (room / scale / (PixelFont.GlyphWidth + PixelFont.Tracking)) - 1);
        return string.Concat(folded.AsSpan(0, Math.Min(characters, folded.Length)).TrimEnd(), "\u2026");
    }

    private static string Fold(string text) => text.ToUpperInvariant();

    /// <summary>
    /// Formats a byte count the way the app's own <c>formatBytes</c> does, so a card and the page it
    /// links to do not disagree about how big something is.
    /// </summary>
    public static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB", "PB"];
        double scaled = bytes;
        var unit = 0;
        while (scaled >= 1024 && unit < units.Length - 1)
        {
            scaled /= 1024;
            unit++;
        }

        var rounded = scaled >= 100 || unit == 0
            ? scaled.ToString("0", CultureInfo.InvariantCulture)
            : scaled.ToString("0.#", CultureInfo.InvariantCulture);
        return $"{rounded} {units[unit]}";
    }
}
