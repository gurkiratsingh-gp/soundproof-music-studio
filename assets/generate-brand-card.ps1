Add-Type -AssemblyName System.Drawing

$width = 1200
$height = 630
$output = Join-Path (Split-Path $PSScriptRoot -Parent) 'public\og.png'
$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

try {
  $bounds = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
  $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $bounds,
    [System.Drawing.ColorTranslator]::FromHtml('#071c22'),
    [System.Drawing.ColorTranslator]::FromHtml('#07524c'),
    22
  )
  $graphics.FillRectangle($background, $bounds)
  $background.Dispose()

  $glow = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $glow.AddEllipse(735, 50, 435, 520)
  $glowBrush = [System.Drawing.Drawing2D.PathGradientBrush]::new($glow)
  $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(80, 53, 205, 180)
  $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 53, 205, 180))
  $graphics.FillPath($glowBrush, $glow)
  $glowBrush.Dispose()
  $glow.Dispose()

  $wavePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(26, 82, 224, 197), 2)
  $wavePath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $wavePath.AddBezier(0, 117, 105, 117, 105, 142, 210, 142)
  $wavePath.AddBezier(210, 142, 315, 142, 315, 117, 420, 117)
  $wavePath.AddBezier(420, 117, 525, 117, 525, 142, 630, 142)
  $graphics.DrawPath($wavePen, $wavePath)
  $wavePath.Dispose()
  $wavePen.Dispose()

  $cream = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#f5f2ea'))
  $teal = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#52e0c5'))
  $muted = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#b9cdc9'))
  $dim = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#73978f'))
  $wordFont = [System.Drawing.Font]::new('Segoe UI', 88, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $tagFont = [System.Drawing.Font]::new('Segoe UI', 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $labelFont = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $soundAt = [System.Drawing.PointF]::new(74, 190)
  $graphics.DrawString('Sound', $wordFont, $cream, $soundAt)
  $soundWidth = $graphics.MeasureString('Sound', $wordFont).Width - 27
  $graphics.DrawString('Proof', $wordFont, $teal, [System.Drawing.PointF]::new(74 + $soundWidth, 190))
  $graphics.FillRectangle($teal, 78, 309, 74, 5)
  $graphics.DrawString('MAKE YOUR SOUND HEARD.', $tagFont, $muted, [System.Drawing.PointF]::new(74, 347))
  $graphics.DrawString('CREATE  /  RECORD  /  MIX', $labelFont, $dim, [System.Drawing.PointF]::new(76, 435))
  $graphics.DrawString('PERSONAL MUSIC STUDIO', $labelFont, $dim, [System.Drawing.PointF]::new(76, 570))

  $shield = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $shield.StartFigure()
  $shield.AddLine(953, 92, 1086, 139)
  $shield.AddLine(1086, 139, 1086, 250)
  $shield.AddBezier(1086, 250, 1086, 371, 1038, 461, 953, 510)
  $shield.AddBezier(953, 510, 868, 461, 820, 371, 820, 250)
  $shield.AddLine(820, 250, 820, 139)
  $shield.CloseFigure()
  $shieldFill = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#0a3034'))
  $shieldPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#35cdb4'), 12)
  $shieldPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.FillPath($shieldFill, $shield)
  $graphics.DrawPath($shieldPen, $shield)

  $pulse = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $pulse.StartFigure()
  $pulse.AddLines([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(850, 293),
    [System.Drawing.PointF]::new(889, 293),
    [System.Drawing.PointF]::new(916, 229),
    [System.Drawing.PointF]::new(954, 365),
    [System.Drawing.PointF]::new(991, 181),
    [System.Drawing.PointF]::new(1022, 293),
    [System.Drawing.PointF]::new(1058, 293)
  ))
  $pulsePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#f5f2ea'), 17)
  $pulsePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pulsePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pulsePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawPath($pulsePen, $pulse)
  $graphics.FillEllipse($teal, 945, 405, 16, 16)

  $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  foreach ($item in @($pulsePen, $pulse, $shieldPen, $shieldFill, $shield, $labelFont, $tagFont, $wordFont, $dim, $muted, $teal, $cream, $graphics, $bitmap)) {
    if ($null -ne $item) { $item.Dispose() }
  }
}

Write-Output $output
