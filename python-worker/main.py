import os
import io
# pyrefly: ignore [missing-import]
from flask import Flask, request, send_file
from gtts import gTTS

app = Flask(__name__)

@app.route('/tts', methods=['POST'])
def generate_tts():
    try:
        data = request.json
        text = data.get('text')
        
        if not text:
            return {"error": "No text provided"}, 400
            
        # Use gTTS to generate speech
        tts = gTTS(text=text, lang='th') # Defaulting to Thai as requested context might imply Thai users, but can be configured
        
        # Save to memory instead of disk for performance
        fp = io.BytesIO()
        tts.write_to_fp(fp)
        fp.seek(0)
        
        return send_file(
            fp,
            mimetype="audio/mpeg",
            as_attachment=True,
            download_name="tts.mp3"
        )
        
    except Exception as e:
        print(f"Error generating TTS: {e}")
        return {"error": str(e)}, 500

if __name__ == '__main__':
    # Run on all interfaces, port 5000
    app.run(host='0.0.0.0', port=5000)
