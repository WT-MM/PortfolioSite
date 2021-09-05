from glob import glob
from bs4 import BeautifulSoup
from PIL import Image
import os


imgCat = glob("../reading/covers/*/")

if os.name == "posix":
    catNames = [i.split("/")[-2] for i in imgCat]
elif os.name == "nt":
    catNames = [i.split("\\")[-2] for i in imgCat]

for i in range(len(imgCat)):
    html = BeautifulSoup("<!DOCTYPE html><html><body></body></html>", 'html.parser')
    itr = 0

    for j in glob(imgCat[i] + "*"):
        div = html.new_tag('div')
        div['class'] = "covercontainer"
        #Disabled for static book cover page
        '''
        if itr==0:
            div['class'] = "carousel-item active"
        else:
            div['class'] = "carousel-item"
        '''
        img = html.new_tag("img")
        img['src'] = j
        img['width'] = "auto"
        img['height'] = "200px"
        img['class'] = "book d-block mx-auto" 
        div.append(img)
        html.find("body").append(div)
        itr += 1
    with open('../templates/' + catNames[i] + 'Books.html', 'w') as f:
        f.write(str(html.prettify()))

