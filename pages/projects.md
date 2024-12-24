---
layout: default
title: Project Portfolio
permalink: /projects/
custom_css: projects.css
warning_message: This page continues to be a work-in-progress
---

<div class="jumbotron" id="title">
  <h1 class='text-center'>Portfolio</h1>
</div>

<div class="container-fluid content-row">
  <div class="row" id="projectsRow">
    {% for project in site.data.projects %}
    <div class="col-sm-6 col-md-4 mb-4">
      <div class="card h-100" onclick="window.location='{{ project.url }}'">
        {% if project.thumbnail %}
        <div class="card-img-container">
          <img class="card-img-top" src="{{ project.thumbnail }}" alt="{{ project.title }}">
        </div>
        {% endif %}
        <div class="card-body">
          <h5 class="card-title">{{ project.title }}</h5>
          <p class="card-text">{{ project.description }}</p>
          {% if project.description2 %}
          <p class="card-text">{{ project.description2 }}</p>
          {% endif %}
          {% if project.external_url %}
          <a href="{{ project.external_url }}" target="_blank">{{ project.external_url }}</a>
          {% endif %}
        </div>
      </div>
    </div>
    {% endfor %}
  </div>
</div>
