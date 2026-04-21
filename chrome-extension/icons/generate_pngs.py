from PIL import Image, ImageDraw

def create_icon(size):
    # Base size for calculation (128x128)
    base_size = 128
    # Oversampling for anti-aliasing
    oversample = 4
    canvas_size = size * oversample
    scale = canvas_size / base_size
    
    # Create a high-res image for drawing
    img = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Define colors
    c1 = (24, 119, 242)   # #1877F2 (Start)
    c2 = (0, 198, 255)    # #00C6FF (End)
    white = (255, 255, 255)
    green = (52, 168, 83)
    
    # 1. Background Gradient (Top-Left to Bottom-Right)
    # Using a mask for rounded corners
    mask = Image.new('L', (canvas_size, canvas_size), 0)
    mask_draw = ImageDraw.Draw(mask)
    radius = int(28 * scale)
    mask_draw.rounded_rectangle([0, 0, canvas_size-1, canvas_size-1], radius=radius, fill=255)
    
    # Draw linear gradient into the masked area
    for i in range(canvas_size * 2):
        # Calculate color at this diagonal
        t = i / (canvas_size * 2)
        r = int(c1[0] + (c2[0] - c1[0]) * t)
        g = int(c1[1] + (c2[1] - c1[1]) * t)
        b = int(c1[2] + (c2[2] - c1[2]) * t)
        # Draw diagonal line
        draw.line([(i, 0), (0, i)], fill=(r, g, b, 255), width=2)
    
    # Apply the rounded corner mask
    final_bg = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
    final_bg.paste(img, (0, 0), mask)
    img = final_bg
    draw = ImageDraw.Draw(img)
    
    # 2. Table/Data Area (semi-transparent white)
    table_rect = [int(24 * scale), int(24 * scale), int(104 * scale), int(104 * scale)]
    draw.rounded_rectangle(table_rect, radius=int(8 * scale), fill=(255, 255, 255, 60))
    
    # 3. Colorful Chart Bars
    bars = [
        (36, 65, 12, 25, (255, 183, 3)),   # Amber
        (54, 45, 12, 45, (251, 133, 0)),   # Orange
        (72, 55, 12, 35, (33, 158, 188)),  # Blue Green
        (90, 35, 12, 55, (142, 202, 230))  # Light Blue
    ]
    for x, y, w, h, color in bars:
        bar_rect = [int(x * scale), int(y * scale), int((x + w) * scale), int((y + h) * scale)]
        draw.rounded_rectangle(bar_rect, radius=int(2 * scale), fill=color)
        
    # 4. Sync Symbol (Bottom Right)
    cx, cy = int(100 * scale), int(100 * scale)
    r = int(22 * scale)
    # Circle
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=green, outline=white, width=max(1, int(3 * scale)))
    
    # Sync Arrows (Matching SVG path logic)
    sync_r = r * 0.4
    thickness = max(1, int(2.5 * scale))
    # Top arc
    draw.arc([cx - sync_r, cy - sync_r, cx + sync_r, cy + sync_r], start=180, end=270, fill=white, width=thickness)
    # Bottom arc
    draw.arc([cx - sync_r, cy - sync_r, cx + sync_r, cy + sync_r], start=0, end=90, fill=white, width=thickness)
    # Arrow heads
    ah_size = int(4 * scale)
    # Top arrowhead (at 270 deg)
    draw.polygon([(cx, cy - sync_r - ah_size), (cx + ah_size, cy - sync_r), (cx, cy - sync_r + ah_size)], fill=white)
    # Bottom arrowhead (at 90 deg)
    draw.polygon([(cx, cy + sync_r - ah_size), (cx - ah_size, cy + sync_r), (cx, cy + sync_r + ah_size)], fill=white)
             
    # Scale down to target size for high-quality anti-aliasing
    return img.resize((size, size), Image.Resampling.LANCZOS)

sizes = [16, 48, 128]
for size in sizes:
    icon = create_icon(size)
    icon.save(f'chrome-extension/icons/icon{size}.png')
    print(f'Generated high-quality icon{size}.png')
