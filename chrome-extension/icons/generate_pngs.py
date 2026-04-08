from PIL import Image, ImageDraw

def create_icon(size):
    # Create a new image with a transparent background
    img = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    
    # Define colors
    blue = (24, 119, 242)  # Facebook Blue
    white = (255, 255, 255)
    green = (52, 168, 83)  # Lark/Google Green
    
    # Scale factors
    scale = size / 128.0
    
    # Background with rounded corners
    radius = int(28 * scale)
    draw.rounded_rectangle([0, 0, size-1, size-1], radius=radius, fill=blue)
    
    # Table/Data Area (semi-transparent white)
    table_rect = [int(24 * scale), int(24 * scale), int(104 * scale), int(104 * scale)]
    draw.rounded_rectangle(table_rect, radius=int(8 * scale), fill=(255, 255, 255, 60)) # ~0.24 opacity
    
    # Chart Bars
    bars = [
        (36, 65, 12, 25),
        (54, 45, 12, 45),
        (72, 55, 12, 35),
        (90, 35, 12, 55)
    ]
    for x, y, w, h in bars:
        bar_rect = [int(x * scale), int(y * scale), int((x + w) * scale), int((y + h) * scale)]
        draw.rounded_rectangle(bar_rect, radius=int(2 * scale), fill=white)
        
    # Sync Symbol (Bottom Right)
    circle_center = (int(100 * scale), int(100 * scale))
    circle_radius = int(22 * scale)
    draw.ellipse([circle_center[0] - circle_radius, circle_center[1] - circle_radius, 
                  circle_center[0] + circle_radius, circle_center[1] + circle_radius], 
                 fill=green, outline=white, width=max(1, int(3 * scale)))
    
    # Add a simple white sync mark (two segments)
    s_scale = circle_radius * 0.5
    draw.arc([circle_center[0] - s_scale, circle_center[1] - s_scale,
              circle_center[0] + s_scale, circle_center[1] + s_scale],
             start=0, end=270, fill=white, width=max(1, int(2 * scale)))
             
    return img

sizes = [16, 48, 128]
for size in sizes:
    icon = create_icon(size)
    icon.save(f'chrome-extension/icons/icon{size}.png')
    print(f'Generated icon{size}.png')
