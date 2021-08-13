from glob import glob
from bs4 import BeautifulSoup
from PIL import Image

def resizeImg(url):
    im = Image.open(url)
    im.resize((1600,2500))
    im.save(url)

imgCat = glob("../reading/covers/*/")
catNames = [i.split("\\")[-2] for i in imgCat]

for i in range(len(imgCat)):
    html = BeautifulSoup("<!DOCTYPE html><html><body></body></html>", 'html.parser')
    itr = 0
    for j in glob(imgCat[i] + "*"):
        resizeImg(j)
        div = html.new_tag('div')
        if itr==0:
            div['class'] = "carousel-item active"
        else:
            div['class'] = "carousel-item"
        img = html.new_tag("img")
        img['src'] = j
        #img['width'] = "100%"
        #img['height'] = "100%"
        img['class'] = "book d-block mx-auto img-fluid" 
        div.append(img)
        html.find("body").append(div)
        itr += 1
    with open('../templates/' + catNames[i] + 'Books.html', 'w') as f:
        f.write(str(html.prettify()))

