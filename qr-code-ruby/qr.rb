require "rqrcode"

# use the RQRCode::QRCode class to encode some text
puts "Enter full URL: "
response = gets

qrcode = RQRCode::QRCode.new("#{response}")

# use the .as_png method to create a 500px x 500px PNG image
png = qrcode.as_png({ :size => 500})

#write the image data to a file


IO.binwrite("sometest.png", png.to_s)

