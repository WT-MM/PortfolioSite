from glob import glob
from bs4 import BeautifulSoup

imgCat = glob("../reading/covers/*/")
catNames = [i.split("\\")[-2] for i in imgCat]

for i in range(len(imgCat)):
    html = BeautifulSoup("<!DOCTYPE html><html><body></body></html>", 'html.parser')
    for j in glob(imgCat[i] + "*"):
        img = html.new_tag("img")
        img['src'] = j
        img['width'] = "100%"
        img['height'] = "auto"
        html.find("body").append(img)
    with open('../templates/' + catNames[i] + 'Books.html', 'w') as f:
        f.write(str(html.prettify()))